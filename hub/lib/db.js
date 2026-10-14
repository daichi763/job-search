// ============================================================
// 求人データハブの DB（SQLite / Node.js 標準の node:sqlite）
//
//   既存アプリのDB（.wrangler/... の D1 ローカル）とは別ファイル。
//   既定: hub/data/jobs_hub.sqlite
//
//   テーブル構成（検索を速く保つため、短い項目と長い文章を分けている）
//     jobs             … 検索・絞り込みに使う項目（1求人1行・幅の狭い表）
//     job_texts        … 仕事内容・応募条件などの長い文章
//     job_raw          … 媒体から取得した元データ（JSONそのまま。「できる限り詳細に」用）
//     job_prefectures  … 勤務地の都道府県（1求人に複数あり得るので別表・索引付き）
//     jobs_fts         … 全文検索の索引（2文字単位）
//     job_changes      … 変更履歴（追加/更新/掲載終了/再掲載/削除）
//     sync_runs        … 同期の実行記録（媒体ごと・1回ごと）
// ============================================================
import { DatabaseSync } from 'node:sqlite'
import fs from 'node:fs'
import path from 'node:path'

export const SCHEMA_VERSION = 1

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT
);

CREATE TABLE IF NOT EXISTS jobs (
  id                  INTEGER PRIMARY KEY,
  source              TEXT NOT NULL,             -- circus | hitolink | jobins | kintone
  source_job_id       TEXT NOT NULL,             -- 媒体側の求人ID
  status              TEXT NOT NULL DEFAULT 'open', -- open=掲載中 / closed=掲載終了(削除待ち)
  title               TEXT,
  company             TEXT,
  company_url         TEXT,
  job_category        TEXT,                      -- 職種（表示用に結合した文字列）
  job_categories_json TEXT,                      -- 職種（配列）
  industry            TEXT,
  industries_json     TEXT,
  employment          TEXT,                      -- 雇用形態
  locations_text      TEXT,                      -- 勤務地（媒体の表記そのまま・結合）
  salary_min          INTEGER,                   -- 想定年収 下限（円）
  salary_max          INTEGER,                   -- 想定年収 上限（円）
  age_min             INTEGER,                   -- 応募可能年齢
  age_max             INTEGER,
  gender              TEXT,                      -- 性別条件（NULL=不問）
  education           TEXT,                      -- 学歴条件（NULL=不問）
  overtime            TEXT,
  holiday             TEXT,
  experience_json     TEXT,                      -- 未経験可・外国籍可など（配列）
  positions_json      TEXT,
  career_stage        TEXT,
  reward_type         TEXT,                      -- 成果報酬: rate | fixed | unknown
  reward_rate         REAL,                      -- 成果報酬率（%）
  reward_amount       INTEGER,                   -- 成果報酬額（円）
  reward_text         TEXT,
  url                 TEXT,
  source_published_at TEXT,                      -- 媒体側の掲載開始(登録)日時
  source_updated_at   TEXT,                      -- 媒体側の最終更新日時
  content_hash        TEXT NOT NULL,             -- 内容が変わったかの判定用
  miss_count          INTEGER NOT NULL DEFAULT 0, -- 連続して一覧に無かった回数
  first_seen_at       TEXT NOT NULL,             -- 初めて取り込んだ日時
  last_changed_at     TEXT NOT NULL,             -- 最後に内容が変わった日時
  closed_at           TEXT,                      -- 掲載終了と判定した日時
  version             INTEGER NOT NULL DEFAULT 1, -- 内容が変わるたびに +1
  UNIQUE(source, source_job_id)
);
CREATE INDEX IF NOT EXISTS idx_jobs_status_source ON jobs(status, source);
CREATE INDEX IF NOT EXISTS idx_jobs_salary   ON jobs(status, salary_max, salary_min);
CREATE INDEX IF NOT EXISTS idx_jobs_changed  ON jobs(status, last_changed_at);
CREATE INDEX IF NOT EXISTS idx_jobs_closed   ON jobs(status, closed_at);
CREATE INDEX IF NOT EXISTS idx_jobs_company  ON jobs(company);

CREATE TABLE IF NOT EXISTS job_texts (
  job_id        INTEGER PRIMARY KEY REFERENCES jobs(id) ON DELETE CASCADE,
  description   TEXT,   -- 仕事内容
  requirements  TEXT,   -- 応募条件
  benefits      TEXT    -- 福利厚生など
);

CREATE TABLE IF NOT EXISTS job_raw (
  job_id      INTEGER PRIMARY KEY REFERENCES jobs(id) ON DELETE CASCADE,
  raw_json    TEXT,     -- 一覧APIの元データ
  raw_hash    TEXT,     -- 元データが変わったかの判定用
  detail_json TEXT,     -- 詳細APIの元データ（取得する媒体のみ・今後）
  fetched_at  TEXT
);

CREATE TABLE IF NOT EXISTS job_prefectures (
  job_id     INTEGER NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  prefecture TEXT NOT NULL,
  PRIMARY KEY (job_id, prefecture)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS idx_job_pref ON job_prefectures(prefecture, job_id);

-- 全文検索（2文字単位のトークンを空白区切りで入れる。本文は保持しない＝容量節約）
CREATE VIRTUAL TABLE IF NOT EXISTS jobs_fts USING fts5(
  head, body,
  content='', contentless_delete=1,
  tokenize='unicode61 remove_diacritics 0'
);

CREATE TABLE IF NOT EXISTS job_changes (
  id             INTEGER PRIMARY KEY,
  job_id         INTEGER,
  source         TEXT NOT NULL,
  source_job_id  TEXT NOT NULL,
  change_type    TEXT NOT NULL,   -- added | updated | closed | reopened | deleted
  changed_fields TEXT,            -- updated のとき、変わった項目名（JSON配列）
  sync_run_id    INTEGER,
  changed_at     TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_changes_at  ON job_changes(changed_at);
CREATE INDEX IF NOT EXISTS idx_changes_job ON job_changes(source, source_job_id);

CREATE TABLE IF NOT EXISTS sync_runs (
  id             INTEGER PRIMARY KEY,
  source         TEXT NOT NULL,
  trigger        TEXT,            -- cron | manual
  status         TEXT NOT NULL,   -- running | done | partial | error | skipped
  started_at     TEXT NOT NULL,
  finished_at    TEXT,
  remote_total   INTEGER,         -- 媒体側の総件数（開始時）
  fetched        INTEGER DEFAULT 0, -- 取得できた件数（重複除く）
  pages_ok       INTEGER DEFAULT 0,
  pages_failed   INTEGER DEFAULT 0,
  added          INTEGER DEFAULT 0,
  updated        INTEGER DEFAULT 0,
  refreshed      INTEGER DEFAULT 0, -- 内容は同じだが媒体の更新日時だけ変わった
  unchanged      INTEGER DEFAULT 0,
  reopened       INTEGER DEFAULT 0,
  missing        INTEGER DEFAULT 0, -- 今回一覧に無かった件数
  closed         INTEGER DEFAULT 0,
  deleted        INTEGER DEFAULT 0,
  complete       INTEGER DEFAULT 0, -- 1=最後まで読み切れた（掲載終了判定を行った）
  close_note     TEXT,             -- 掲載終了の判定をしなかった理由など
  error          TEXT,
  duration_sec   INTEGER
);
CREATE INDEX IF NOT EXISTS idx_runs_source ON sync_runs(source, started_at);
`

export function openDb(dbPath, { readonly = false } = {}) {
  if (!readonly) fs.mkdirSync(path.dirname(dbPath), { recursive: true })
  const db = new DatabaseSync(dbPath, readonly ? { readOnly: true } : {})
  db.exec('PRAGMA busy_timeout = 10000')
  if (!readonly) {
    db.exec('PRAGMA journal_mode = WAL')   // 同期中も検索（読み取り）を止めない
    db.exec('PRAGMA synchronous = NORMAL')
    db.exec('PRAGMA foreign_keys = ON')
    db.exec(SCHEMA)
    db.prepare(`INSERT INTO meta(key,value) VALUES('schema_version',?)
                ON CONFLICT(key) DO UPDATE SET value=excluded.value`).run(String(SCHEMA_VERSION))
  }
  return db
}

// トランザクション実行（失敗したら巻き戻す）
export function tx(db, fn) {
  db.exec('BEGIN IMMEDIATE')
  try {
    const r = fn()
    db.exec('COMMIT')
    return r
  } catch (e) {
    try { db.exec('ROLLBACK') } catch {}
    throw e
  }
}

export const nowIso = () => new Date().toISOString()
