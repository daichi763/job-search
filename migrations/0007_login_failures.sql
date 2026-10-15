-- ============================================================
-- 0007: ログイン失敗の記録（総当たり対策）
--   0006 を先に適用した環境ではこの表が無いため、ここで作る（すでにあれば何もしない）
-- ============================================================
CREATE TABLE IF NOT EXISTS login_failures (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  login_id   TEXT NOT NULL,
  ip         TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_login_failures ON login_failures(login_id, created_at);
