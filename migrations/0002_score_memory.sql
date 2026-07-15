-- ============================================================
-- AI採点結果の記憶
--   「要望の型(criteria_hash)」× 求人 の採点結果をキャッシュ。
--   同じような要望で再検索した際、公開中の求人ならAIを呼ばず即提案できる。
--   これによりトークンを節約し、体感速度を上げる。
-- ============================================================
CREATE TABLE IF NOT EXISTS score_memory (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  criteria_hash TEXT NOT NULL,           -- 検索条件の正規化ハッシュ
  source        TEXT NOT NULL,
  source_job_id TEXT NOT NULL,
  score         INTEGER NOT NULL,
  reason        TEXT,
  scored_at     TEXT DEFAULT (datetime('now')),
  UNIQUE(criteria_hash, source, source_job_id)
);
CREATE INDEX IF NOT EXISTS idx_score_memory_hash ON score_memory(criteria_hash, score DESC);
