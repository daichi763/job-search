#!/usr/bin/env node
// ============================================================
// ハブDBの状況表示（読み取りのみ）
//   node --no-warnings bin/status.js
// ============================================================
import fs from 'node:fs'
import { openDb } from '../lib/db.js'
import { config } from '../lib/env.js'

const cfg = config()
if (!fs.existsSync(cfg.dbPath)) { console.log(`まだDBがありません: ${cfg.dbPath}`); process.exit(0) }
const db = openDb(cfg.dbPath, { readonly: true })
const t = (rows) => console.table(rows)

console.log(`DB: ${cfg.dbPath}  (${(fs.statSync(cfg.dbPath).size / 1024 / 1024).toFixed(1)} MB)`)
console.log('\n■ 媒体別の件数')
t(db.prepare(`SELECT source AS 媒体, SUM(status='open') AS 掲載中, SUM(status='closed') AS 掲載終了_削除待ち,
  MAX(last_changed_at) AS 最終変更 FROM jobs GROUP BY source`).all())

console.log('\n■ 直近の同期（新しい順10件）')
t(db.prepare(`SELECT id, source AS 媒体, status AS 状態, substr(started_at,1,16) AS 開始UTC, duration_sec AS 秒,
  remote_total AS 媒体総数, fetched AS 取得, added AS 追加, updated AS 更新, refreshed AS 軽更新, unchanged AS 変化なし,
  reopened AS 再掲載, missing AS 一覧に無し, closed AS 掲載終了, deleted AS 削除, pages_failed AS 失敗頁, complete AS 完走
  FROM sync_runs ORDER BY id DESC LIMIT 10`).all())
const notes = db.prepare(`SELECT id, source, close_note, error FROM sync_runs WHERE (close_note IS NOT NULL OR error IS NOT NULL) ORDER BY id DESC LIMIT 5`).all()
if (notes.length) { console.log('\n■ 注意事項（直近）'); for (const n of notes) console.log(`  #${n.id} ${n.source}: ${n.error || ''} ${n.close_note || ''}`) }

console.log('\n■ 変更履歴（直近24時間）')
t(db.prepare(`SELECT source AS 媒体, change_type AS 種類, COUNT(*) AS 件数 FROM job_changes
  WHERE changed_at >= ? GROUP BY 1,2 ORDER BY 1,2`).all(new Date(Date.now() - 86400000).toISOString()))

console.log('\n■ 更新で変わった項目（直近24時間・上位）')
const fields = {}
for (const r of db.prepare(`SELECT changed_fields FROM job_changes WHERE change_type='updated' AND changed_at >= ?`).iterate(new Date(Date.now() - 86400000).toISOString())) {
  for (const f of JSON.parse(r.changed_fields || '[]')) fields[f] = (fields[f] || 0) + 1
}
t(Object.entries(fields).sort((a, b) => b[1] - a[1]).slice(0, 15).map(([項目, 件数]) => ({ 項目, 件数 })))
db.close()
