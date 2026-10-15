// 既存の求人に働き方タグを付け直す（判定ルールを変えたとき・初回導入時）
import { detectFeatures } from './features.js'
import { tx } from './db.js'

export function backfillFeatures(db, { log = () => {}, batch = 2000 } = {}) {
  const total = db.prepare(`SELECT COUNT(*) AS n FROM jobs`).get().n
  const sel = db.prepare(`SELECT j.id, j.source, j.title, j.job_category, j.employment, j.overtime, j.holiday, j.reward_text,
      j.experience_json, t.description, t.requirements, t.benefits, r.raw_json
    FROM jobs j LEFT JOIN job_texts t ON t.job_id=j.id LEFT JOIN job_raw r ON r.job_id=j.id
    WHERE j.id > ? ORDER BY j.id LIMIT ?`)
  const del = db.prepare(`DELETE FROM job_features WHERE job_id=?`)
  const ins = db.prepare(`INSERT OR IGNORE INTO job_features(job_id, feature) VALUES (?,?)`)
  let last = 0, done = 0
  const counts = {}
  while (true) {
    const rows = sel.all(last, batch)
    if (!rows.length) break
    tx(db, () => {
      for (const r of rows) {
        let raw = null
        try { raw = r.raw_json ? JSON.parse(r.raw_json) : null } catch {}
        let exp = []
        try { exp = JSON.parse(r.experience_json || '[]') } catch {}
        const f = detectFeatures(r.source, { ...r, experience: exp }, raw)
        del.run(r.id)
        for (const x of f) { ins.run(r.id, x); counts[x] = (counts[x] || 0) + 1 }
      }
    })
    last = rows[rows.length - 1].id
    done += rows.length
    if (done % 20000 < batch) log(`${done.toLocaleString()} / ${total.toLocaleString()} 件`)
  }
  return { total: done, counts }
}
