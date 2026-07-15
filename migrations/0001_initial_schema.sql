-- ============================================================
-- 求人横断検索AI アプリ  D1 スキーマ
-- ============================================================

-- ------------------------------------------------------------
-- 求人キャッシュ (AI担当の「記憶」)
--   4つのDB(source)から取得した求人を正規化して保存する。
--   再検索時にここを先に見て、公開中(is_open=1)なら即提案できる。
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS jobs (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  source        TEXT NOT NULL,            -- 'kintone' | 'circus' | 'hitolink' | 'jobins'
  source_job_id TEXT NOT NULL,            -- 各DBでの求人ID(重複判定キー)
  title         TEXT,                     -- 求人タイトル
  company       TEXT,                     -- 企業名
  job_category  TEXT,                     -- 職種(大分類など)
  industry      TEXT,                     -- 業種
  employment    TEXT,                     -- 雇用形態
  locations     TEXT,                     -- 勤務地(カンマ区切り or JSON)
  salary_min    INTEGER,                  -- 想定年収下限(万円)
  salary_max    INTEGER,                  -- 想定年収上限(万円)
  overtime      TEXT,                     -- 残業時間
  holiday       TEXT,                     -- 休日
  benefits      TEXT,                     -- 福利厚生
  requirements  TEXT,                     -- 応募必須条件
  description   TEXT,                     -- 仕事内容(フリーテキスト)
  raw_json      TEXT,                     -- 元データ全体(JSON)
  url           TEXT,                     -- 求人詳細URL
  is_open       INTEGER NOT NULL DEFAULT 1, -- 公開中か(1=公開,0=非公開/クローズ)
  first_seen_at TEXT DEFAULT (datetime('now')),
  last_seen_at  TEXT DEFAULT (datetime('now')),
  updated_at    TEXT DEFAULT (datetime('now')),
  UNIQUE(source, source_job_id)
);
CREATE INDEX IF NOT EXISTS idx_jobs_source ON jobs(source);
CREATE INDEX IF NOT EXISTS idx_jobs_open ON jobs(is_open);
CREATE INDEX IF NOT EXISTS idx_jobs_salary ON jobs(salary_min, salary_max);
CREATE INDEX IF NOT EXISTS idx_jobs_category ON jobs(job_category);

-- ------------------------------------------------------------
-- 検索ジョブ (1回の検索リクエスト全体)
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS search_jobs (
  id            TEXT PRIMARY KEY,          -- UUID
  criteria_json TEXT NOT NULL,             -- 入力された検索条件(JSON)
  free_text     TEXT,                      -- フリー記述の要望
  top_n         INTEGER NOT NULL DEFAULT 10, -- 払い出す求人数
  status        TEXT NOT NULL DEFAULT 'running', -- running|done|error
  created_at    TEXT DEFAULT (datetime('now')),
  finished_at   TEXT,
  total_scanned INTEGER DEFAULT 0,         -- スキャンした総求人数
  total_matched INTEGER DEFAULT 0          -- 見つかったマッチ数
);
CREATE INDEX IF NOT EXISTS idx_search_jobs_status ON search_jobs(status);

-- ------------------------------------------------------------
-- AI担当(ワーカー)の稼働状態  … 可視化用
--   各DB担当が「今何をしているか」をリアルタイムに記録する。
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS worker_states (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  search_job_id TEXT NOT NULL,
  source        TEXT NOT NULL,             -- 担当DB
  phase         TEXT NOT NULL DEFAULT 'idle', -- idle|fetching|filtering|scoring|done|error|skipped
  message       TEXT,                      -- 表示メッセージ
  scanned       INTEGER DEFAULT 0,         -- スキャン済み件数
  candidates    INTEGER DEFAULT 0,         -- 機械フィルタ通過件数
  matched       INTEGER DEFAULT 0,         -- AI採点でマッチ判定した件数
  from_memory   INTEGER DEFAULT 0,         -- 記憶から即提案できた件数
  tokens_used   INTEGER DEFAULT 0,         -- 消費トークン(概算)
  total_in_db   INTEGER DEFAULT 0,         -- そのDBの総求人数
  updated_at    TEXT DEFAULT (datetime('now')),
  UNIQUE(search_job_id, source)
);
CREATE INDEX IF NOT EXISTS idx_worker_states_job ON worker_states(search_job_id);

-- ------------------------------------------------------------
-- 検索結果 (逐次払い出し用)
--   ワーカーが求人を見つけ次第ここへINSERT。フロントはポーリングで拾う。
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS search_results (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  search_job_id TEXT NOT NULL,
  source        TEXT NOT NULL,
  source_job_id TEXT NOT NULL,
  score         INTEGER NOT NULL DEFAULT 0, -- 一致度 0-100
  reason        TEXT,                       -- AIによるマッチ理由
  job_json      TEXT NOT NULL,              -- 表示用求人データ(JSON)
  from_memory   INTEGER DEFAULT 0,          -- 記憶から出したか
  created_at    TEXT DEFAULT (datetime('now')),
  UNIQUE(search_job_id, source, source_job_id)
);
CREATE INDEX IF NOT EXISTS idx_search_results_job ON search_results(search_job_id, score DESC);

-- ------------------------------------------------------------
-- DB統計(総求人数キャッシュ)
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS db_stats (
  source        TEXT PRIMARY KEY,
  total_jobs    INTEGER DEFAULT 0,
  open_jobs     INTEGER DEFAULT 0,
  cached_jobs   INTEGER DEFAULT 0,
  last_synced_at TEXT
);
