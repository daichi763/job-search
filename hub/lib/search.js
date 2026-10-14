// ============================================================
// 検索（段階3の検索APIでもこの関数をそのまま使う）
// ============================================================
import { toMatchQuery } from './text.js'

export function searchJobs(db, q = {}) {
  const where = [`j.status = 'open'`]
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
  if (q.changedSince) { where.push(`j.last_changed_at >= ?`); args.push(q.changedSince) }

  const order = {
    updated: 'j.last_changed_at DESC',
    new: 'j.first_seen_at DESC',
    salary_desc: 'j.salary_max IS NULL, j.salary_max DESC',
    salary_asc: 'j.salary_min IS NULL, j.salary_min ASC',
  }[q.sort || 'updated'] || 'j.last_changed_at DESC'
  const limit = Math.min(Math.max(parseInt(q.limit ?? 20, 10) || 20, 1), 200)
  const offset = Math.max(parseInt(q.offset ?? 0, 10) || 0, 0)
  const w = where.join(' AND ')

  const total = db.prepare(`SELECT COUNT(*) AS n FROM ${from} WHERE ${w}`).get(...args).n
  const rows = db.prepare(`SELECT j.* FROM ${from} WHERE ${w} ORDER BY ${order} LIMIT ? OFFSET ?`).all(...args, limit, offset)
  return { total, limit, offset, jobs: rows }
}
