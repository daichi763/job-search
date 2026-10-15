// ============================================================
// 検索（段階3の検索APIでもこの関数をそのまま使う）
// ============================================================
import { toMatchQuery } from './text.js'

export function searchJobs(db, q = {}) {
  const where = []
  if (q.status === 'closed') where.push(`j.status = 'closed'`)
  else if (q.status !== 'all') where.push(`j.status = 'open'`)
  const args = []
  let from = 'jobs j'

  if (q.keyword && String(q.keyword).trim()) {
    const { match, singleChars } = toMatchQuery(q.keyword)
    if (match) {
      where.push(`j.id IN (SELECT rowid FROM jobs_fts WHERE jobs_fts MATCH ?)`)
      args.push(match)
    }
    // 1文字だけの語（例:「寮」）は索引で引けないので文章を直接探す
    for (const ch of singleChars) {
      where.push(`(j.title LIKE ? OR j.company LIKE ? OR EXISTS (SELECT 1 FROM job_texts t WHERE t.job_id=j.id AND (t.description LIKE ? OR t.requirements LIKE ?)))`)
      args.push(...Array(4).fill(`%${ch}%`))
    }
  }
  if (q.source) {
    const list = [].concat(q.source).flatMap((s) => String(s).split(',')).filter(Boolean)
    where.push(`j.source IN (${list.map(() => '?').join(',')})`)
    args.push(...list)
  }
  if (q.prefecture) {
    const list = [].concat(q.prefecture).flatMap((s) => String(s).split(',')).filter(Boolean)
    where.push(`j.id IN (SELECT job_id FROM job_prefectures WHERE prefecture IN (${list.map(() => '?').join(',')}))`)
    args.push(...list)
  }
  // 希望年収（円）: 上限がこれ以上の求人（上限不明は含める）
  if (q.salaryMin != null && q.salaryMin !== '') { where.push(`(j.salary_max IS NULL OR j.salary_max >= ?)`); args.push(Number(q.salaryMin)) }
  if (q.salaryMax != null && q.salaryMax !== '') { where.push(`(j.salary_min IS NULL OR j.salary_min <= ?)`); args.push(Number(q.salaryMax)) }
  if (q.age != null && q.age !== '') {
    where.push(`(j.age_min IS NULL OR j.age_min <= ?) AND (j.age_max IS NULL OR j.age_max >= ?)`)
    args.push(Number(q.age), Number(q.age))
  }
  if (q.employment) { where.push(`j.employment LIKE ?`); args.push(`%${q.employment}%`) }
  if (q.category) { where.push(`(j.job_category LIKE ? OR j.job_categories_json LIKE ?)`); args.push(`%${q.category}%`, `%${q.category}%`) }
  if (q.company) { where.push(`j.company LIKE ?`); args.push(`%${q.company}%`) }
  if (q.rewardType) { where.push(`j.reward_type = ?`); args.push(q.rewardType) }
  if (q.changedSince) { where.push(`j.last_changed_at >= ?`); args.push(q.changedSince) }

  const order = {
    updated: 'j.last_changed_at DESC',
    new: 'j.first_seen_at DESC',
    salary_desc: 'j.salary_max IS NULL, j.salary_max DESC',
    salary_asc: 'j.salary_min IS NULL, j.salary_min ASC',
  }[q.sort || 'updated'] || 'j.last_changed_at DESC'
  const limit = Math.min(Math.max(parseInt(q.limit ?? 20, 10) || 20, 1), 200)
  const offset = Math.max(parseInt(q.offset ?? 0, 10) || 0, 0)
  const w = where.length ? where.join(' AND ') : '1=1'

  const total = db.prepare(`SELECT COUNT(*) AS n FROM ${from} WHERE ${w}`).get(...args).n
  const rows = db.prepare(`SELECT j.* FROM ${from} WHERE ${w} ORDER BY ${order} LIMIT ? OFFSET ?`).all(...args, limit, offset)
  return { total, limit, offset, jobs: rows }
}

// 求人1件の詳細（文章・元データ・都道府県・変更履歴を含む）
export function getJob(db, id) {
  const j = db.prepare(`SELECT * FROM jobs WHERE id=?`).get(Number(id))
  if (!j) return null
  const t = db.prepare(`SELECT description, requirements, benefits FROM job_texts WHERE job_id=?`).get(j.id) || {}
  const r = db.prepare(`SELECT raw_json, detail_json, fetched_at FROM job_raw WHERE job_id=?`).get(j.id) || {}
  const prefs = db.prepare(`SELECT prefecture FROM job_prefectures WHERE job_id=? ORDER BY prefecture`).all(j.id).map((x) => x.prefecture)
  const changes = db.prepare(`SELECT change_type, changed_fields, changed_at FROM job_changes
                              WHERE source=? AND source_job_id=? ORDER BY id DESC LIMIT 30`).all(j.source, j.source_job_id)
  const parse = (s) => { try { return s ? JSON.parse(s) : null } catch { return null } }
  return {
    ...j,
    job_categories: parse(j.job_categories_json) || [], industries: parse(j.industries_json) || [],
    experience: parse(j.experience_json) || [], positions: parse(j.positions_json) || [],
    prefectures: prefs, ...t,
    raw: parse(r.raw_json), detail: parse(r.detail_json), raw_fetched_at: r.fetched_at || null,
    changes: changes.map((c) => ({ ...c, changed_fields: parse(c.changed_fields) })),
  }
}

// 絞り込みの選択肢と全体の状況（画面の初期表示用）
export function getOverview(db) {
  const bySource = db.prepare(`SELECT source, SUM(status='open') AS open, SUM(status='closed') AS closed FROM jobs GROUP BY source`).all()
  const prefs = db.prepare(`SELECT p.prefecture, COUNT(*) AS n FROM job_prefectures p JOIN jobs j ON j.id=p.job_id
                            WHERE j.status='open' GROUP BY p.prefecture ORDER BY n DESC`).all()
  const runs = db.prepare(`SELECT source, status, started_at, finished_at, remote_total, fetched, added, updated, missing, closed, deleted, complete, close_note
                           FROM sync_runs WHERE id IN (SELECT MAX(id) FROM sync_runs GROUP BY source)`).all()
  const since = new Date(Date.now() - 86400000).toISOString()
  const changes = db.prepare(`SELECT source, change_type, COUNT(*) AS n FROM job_changes WHERE changed_at >= ? GROUP BY 1,2`).all(since)
  return { bySource, prefectures: prefs, lastRuns: runs, changes24h: changes }
}
