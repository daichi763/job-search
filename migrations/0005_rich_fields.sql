-- ============================================================
-- 0005: 手動検索モードの拡充
--   各アダプタが出力しているのに jobs テーブルに列がなく捨てていた
--   リッチ情報を保存できるようにカラムを追加する。
--   加えて、差分同期(一致IDスキップ)の判定を速くするための索引も張る。
--
--   ※ D1(SQLite)は ADD COLUMN のみ可(DROP/変更不可)。既存列は温存。
-- ============================================================

-- 追加のリッチ列（すべて NULL 許容。既存行は NULL のまま）
ALTER TABLE jobs ADD COLUMN company_website     TEXT;   -- 企業サイトURL
ALTER TABLE jobs ADD COLUMN job_categories_json TEXT;   -- 職種(配列JSON)
ALTER TABLE jobs ADD COLUMN industries_json     TEXT;   -- 業種(配列JSON)
ALTER TABLE jobs ADD COLUMN positions_json      TEXT;   -- 役職/ポジション(配列JSON)
ALTER TABLE jobs ADD COLUMN career_stage        TEXT;   -- キャリア段階
ALTER TABLE jobs ADD COLUMN experience_json     TEXT;   -- 未経験可否/外国籍等(配列JSON)
ALTER TABLE jobs ADD COLUMN required_age_min    INTEGER; -- 応募可能年齢(下限)
ALTER TABLE jobs ADD COLUMN required_age_max    INTEGER; -- 応募可能年齢(上限)
ALTER TABLE jobs ADD COLUMN required_gender     TEXT;   -- 性別条件(NULL=不問)
ALTER TABLE jobs ADD COLUMN required_education  TEXT;   -- 学歴条件(NULL=不問)
ALTER TABLE jobs ADD COLUMN reward_type         TEXT;   -- 成果報酬タイプ(rate|fixed|unknown)
ALTER TABLE jobs ADD COLUMN reward_rate         REAL;   -- 成果報酬率(%)
ALTER TABLE jobs ADD COLUMN reward_amount       INTEGER; -- 成果報酬額(円)
ALTER TABLE jobs ADD COLUMN reward_text         TEXT;   -- 成果報酬(表示文言)
ALTER TABLE jobs ADD COLUMN publish_started_at  TEXT;   -- 掲載開始日時(媒体側)
ALTER TABLE jobs ADD COLUMN source_updated_at   TEXT;   -- 媒体側の最終更新日時
ALTER TABLE jobs ADD COLUMN content_hash        TEXT;   -- 差分検出用の内容ハッシュ

-- 差分同期・絞り込み用の索引
CREATE INDEX IF NOT EXISTS idx_jobs_src_sid ON jobs(source, source_job_id);
CREATE INDEX IF NOT EXISTS idx_jobs_employment ON jobs(employment);
CREATE INDEX IF NOT EXISTS idx_jobs_reward_type ON jobs(reward_type);
CREATE INDEX IF NOT EXISTS idx_jobs_req_edu ON jobs(required_education);

-- 差分同期でスキップした件数(内容変化なし)を進捗に表示するための列
ALTER TABLE trace_states ADD COLUMN skipped INTEGER DEFAULT 0;
-- 取得に失敗して諦めたページ数(部分取り込みの可視化)
ALTER TABLE trace_states ADD COLUMN failed_pages INTEGER DEFAULT 0;
