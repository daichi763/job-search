-- ============================================================
-- 媒体ごとの「最終検索時の総求人数」
--   各DB(circus等)の外部ワーカーが検索を完了するたびに、
--   その検索で判明した総該当件数(その媒体の掲載総数の目安)を上書き保存する。
--   フロント右上「総求人数」はこの値の合算で表示する。
--   kintoneは従来通りライブカウントするため必須ではないが、統一のため許容。
-- ============================================================
CREATE TABLE IF NOT EXISTS source_totals (
  source      TEXT PRIMARY KEY,       -- 'circus' | 'hitolink' | 'jobins' | 'kintone'
  total       INTEGER NOT NULL DEFAULT 0, -- 最終検索時の総求人数
  updated_at  TEXT DEFAULT (datetime('now'))
);
