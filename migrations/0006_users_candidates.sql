-- ============================================================
-- 0006: ログイン制・求職者ごとの検索履歴・紹介済み・書類
--   ・users          … 担当者（ログインID・パスワード・権限）
--   ・sessions       … ログイン状態（トークンはハッシュで保存）
--   ・candidates     … 求職者（名前＋自動採番 id。同姓同名は番号で区別）
--   ・candidate_documents … 書類（PDFそのものは解析後に破棄し、個人情報を伏せた本文と解析結果だけ残す）
--   ・candidate_referrals … 紹介済みの求人
--   ・search_jobs に 検索した担当者・求職者・方式 を追加
-- ============================================================

CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  login_id      TEXT NOT NULL UNIQUE,       -- メールアドレス（小文字で保存）
  name          TEXT NOT NULL,              -- 表示名（検索担当者名）
  password_hash TEXT NOT NULL,              -- pbkdf2$反復回数$salt$hash
  role          TEXT NOT NULL DEFAULT 'staff', -- admin | staff
  active        INTEGER NOT NULL DEFAULT 1,
  created_at    TEXT DEFAULT (datetime('now')),
  last_login_at TEXT
);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash  TEXT PRIMARY KEY,
  user_id     INTEGER NOT NULL,
  created_at  TEXT DEFAULT (datetime('now')),
  expires_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);

-- ログイン失敗の記録（総当たり対策: 同じログインIDで15分に10回失敗したら一時的にロック）
CREATE TABLE IF NOT EXISTS login_failures (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  login_id   TEXT NOT NULL,
  ip         TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_login_failures ON login_failures(login_id, created_at);

CREATE TABLE IF NOT EXISTS candidates (
  id            INTEGER PRIMARY KEY AUTOINCREMENT, -- 自動採番（画面では No.123）
  name          TEXT NOT NULL,
  name_kana     TEXT,
  memo          TEXT,                       -- 担当者の補足（AI検索でも参照する）
  conditions_json TEXT,                     -- 最後に使った検索条件（呼び出して再検索する用）
  profile_json  TEXT,                       -- 書類から読み取った経歴（全書類をまとめた解析結果）
  profile_status TEXT,                      -- null | pending | done | error
  profile_error TEXT,
  profile_updated_at TEXT,
  created_by    INTEGER,
  updated_by    INTEGER,
  created_at    TEXT DEFAULT (datetime('now')),
  updated_at    TEXT DEFAULT (datetime('now')),
  archived      INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_candidates_name ON candidates(name);
CREATE INDEX IF NOT EXISTS idx_candidates_updated ON candidates(updated_at);

CREATE TABLE IF NOT EXISTS candidate_documents (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  candidate_id INTEGER NOT NULL,
  kind         TEXT NOT NULL DEFAULT 'other', -- resume=履歴書 | cv=職務経歴書 | other
  filename     TEXT,
  status       TEXT NOT NULL DEFAULT 'pending', -- pending | done | error
  error        TEXT,
  pdf_base64   TEXT,                        -- 解析待ちの間だけ一時保存（解析後に必ず消す）
  masked_text  TEXT,                        -- 個人情報を伏せた本文
  pages        INTEGER,
  chars        INTEGER,
  created_by   INTEGER,
  created_at   TEXT DEFAULT (datetime('now')),
  processed_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_cdocs_candidate ON candidate_documents(candidate_id);
CREATE INDEX IF NOT EXISTS idx_cdocs_status ON candidate_documents(status);

CREATE TABLE IF NOT EXISTS candidate_referrals (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  candidate_id  INTEGER NOT NULL,
  source        TEXT NOT NULL,
  source_job_id TEXT NOT NULL,
  title         TEXT,
  company       TEXT,
  note          TEXT,
  search_job_id TEXT,
  created_by    INTEGER,
  created_at    TEXT DEFAULT (datetime('now')),
  UNIQUE(candidate_id, source, source_job_id)
);
CREATE INDEX IF NOT EXISTS idx_referrals_candidate ON candidate_referrals(candidate_id);

ALTER TABLE search_jobs ADD COLUMN user_id INTEGER;
ALTER TABLE search_jobs ADD COLUMN user_name TEXT;
ALTER TABLE search_jobs ADD COLUMN candidate_id INTEGER;
ALTER TABLE search_jobs ADD COLUMN engine TEXT;   -- hub（求人DB・新方式） | legacy（媒体に直接ログインする旧方式）
ALTER TABLE search_jobs ADD COLUMN note TEXT;     -- 完了時の要約（件数・費用の目安など）
CREATE INDEX IF NOT EXISTS idx_search_jobs_candidate ON search_jobs(candidate_id, created_at);
CREATE INDEX IF NOT EXISTS idx_search_jobs_user ON search_jobs(user_id, created_at);
