-- ============================================================
-- 手動検索モード用: 自社DBへの全求人トレース(ミラーリング)
--
--  役割:
--   ・4つのDB(circus/hitolink/jobins/kintone)の全求人を jobs テーブルへコピー(upsert)。
--   ・毎日実行し、新着求人の追加と、掲載終了求人の把握(is_open=0)を行う。
--
--  設計:
--   ・trace_jobs      … 1回の同期(全媒体 or 単一媒体)の実行単位。ステータス管理。
--   ・trace_states    … 媒体ごとの同期進捗(検索ジョブの worker_states 相当)。
--   ・jobs.trace_sync_at … 最後にトレース同期で「掲載を確認できた」時刻。
--       同期完了時、開始時刻より trace_sync_at が古い(=今回見つからなかった)
--       求人を掲載終了(is_open=0)とみなす。
-- ============================================================

-- 1回の同期実行(全媒体 or 単一媒体)
CREATE TABLE IF NOT EXISTS trace_jobs (
  id            TEXT PRIMARY KEY,             -- UUID
  sources_json  TEXT NOT NULL,                -- 対象媒体の配列(JSON) 例: ["circus","hitolink","jobins","kintone"]
  status        TEXT NOT NULL DEFAULT 'running', -- running|done|error|cancelled
  trigger       TEXT DEFAULT 'manual',        -- manual|cron
  started_at    TEXT DEFAULT (datetime('now')),-- 同期開始時刻(削除検知の基準)
  finished_at   TEXT,
  total_upserted INTEGER DEFAULT 0,           -- 追加/更新した求人数(全媒体合計)
  total_closed   INTEGER DEFAULT 0,           -- 掲載終了とマークした求人数(全媒体合計)
  total_added    INTEGER DEFAULT 0            -- 新規に登録した求人数(全媒体合計)
);
CREATE INDEX IF NOT EXISTS idx_trace_jobs_status ON trace_jobs(status);
CREATE INDEX IF NOT EXISTS idx_trace_jobs_started ON trace_jobs(started_at DESC);

-- 媒体ごとの同期進捗
CREATE TABLE IF NOT EXISTS trace_states (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  trace_job_id  TEXT NOT NULL,
  source        TEXT NOT NULL,                -- 担当DB
  phase         TEXT NOT NULL DEFAULT 'pending', -- pending|fetching|upserting|closing|done|error
  message       TEXT,                         -- 表示メッセージ
  total         INTEGER DEFAULT 0,            -- 媒体の総求人数(判明分)
  fetched       INTEGER DEFAULT 0,            -- 取得済み件数
  upserted      INTEGER DEFAULT 0,            -- upsert済み件数
  added         INTEGER DEFAULT 0,            -- 新規登録件数
  closed        INTEGER DEFAULT 0,            -- 掲載終了マーク件数
  updated_at    TEXT DEFAULT (datetime('now')),
  UNIQUE(trace_job_id, source)
);
CREATE INDEX IF NOT EXISTS idx_trace_states_job ON trace_states(trace_job_id);

-- jobs テーブルに「最後にトレース同期で掲載確認できた時刻」列を追加。
--   NULL可(既存行/AI検索由来の行は同期対象外扱い)。
ALTER TABLE jobs ADD COLUMN trace_sync_at TEXT;
CREATE INDEX IF NOT EXISTS idx_jobs_trace_sync ON jobs(source, trace_sync_at);

-- 手動検索の企業名・タイトル絞り込みを速くするための補助インデックス
CREATE INDEX IF NOT EXISTS idx_jobs_company ON jobs(company);
CREATE INDEX IF NOT EXISTS idx_jobs_industry ON jobs(industry);
CREATE INDEX IF NOT EXISTS idx_jobs_employment ON jobs(employment);
