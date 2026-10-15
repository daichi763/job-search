// ============================================================
// 検索（段階3の検索APIでもこの関数をそのまま使う）
// ============================================================
import { toMatchQuery } from './text.js'

// 該当件数の記憶（同じ条件の2ページ目以降・同じ検索の繰り返しで件数を数え直さない）
//   データが変わる（同期が終わる）と自動で捨てる
const countCache = new Map()
let cacheVersion = null
function dataVersion(db) {
  try { return db.prepare(`SELECT MAX(id) AS v, MAX(finished_at) AS f FROM sync_runs`).get() } catch { return null }
}

// 検索条件 → WHERE 句（画面の検索・API・AI検索の対象抽出で共通）
export function buildWhere(q = {}) {
  const where = []
  if (q.status === 'closed') where.push(`j.status = 'closed'`)
  else if (q.status !== 'all') where.push(`j.status = 'open'`)
  const args = []

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
  // 雇用形態・職種は複数指定可（カンマ区切り = いずれかを含む）
  const anyLike = (cols, value) => {
    const words = [].concat(value).flatMap((v) => String(v).split(',')).map((w) => w.trim()).filter(Boolean)
    if (!words.length) return
    where.push('(' + words.map(() => '(' + cols.map((c) => `${c} LIKE ?`).join(' OR ') + ')').join(' OR ') + ')')
    for (const w of words) for (const _ of cols) args.push(`%${w}%`)
  }
  if (q.employment) anyLike(['j.employment'], q.employment)
  if (q.category) anyLike(['j.job_category', 'j.job_categories_json'], q.category)
  // 働き方の特徴（カンマ区切り = すべて満たす）: remote, flex, side_job, no_transfer, holidays_120, weekend_off, inexperienced_ok, short_time
  if (q.features) {
    const fs = [].concat(q.features).flatMap((v) => String(v).split(',')).map((w) => w.trim()).filter(Boolean)
    for (const f of fs) { where.push(`j.id IN (SELECT job_id FROM job_features WHERE feature = ?)`); args.push(f) }
  }
  // 除外する求人（「媒体:ID」のカンマ区切り。紹介済みなどを外す用途）
  if (q.excludeKeys) {
    const ks = [].concat(q.excludeKeys).flatMap((v) => String(v).split(',')).map((w) => w.trim()).filter((w) => w.includes(':')).slice(0, 1000)
    if (ks.length) {
      where.push(`(j.source || ':' || j.source_job_id) NOT IN (${ks.map(() => '?').join(',')})`)
      args.push(...ks)
    }
  }
  if (q.company) { where.push(`j.company LIKE ?`); args.push(`%${q.company}%`) }
  if (q.rewardType) { where.push(`j.reward_type = ?`); args.push(q.rewardType) }
  if (q.changedSince) { where.push(`j.last_changed_at >= ?`); args.push(q.changedSince) }
  // 求人を指定（「媒体:ID」のカンマ区切り。手動検索で選んだ求人だけをAIにかける用途）
  if (q.jobKeys) {
    const ks = [].concat(q.jobKeys).flatMap((v) => String(v).split(',')).map((w) => w.trim()).filter((w) => w.includes(':')).slice(0, 5000)
    where.push(ks.length ? `(j.source || ':' || j.source_job_id) IN (${ks.map(() => '?').join(',')})` : '0')
    args.push(...ks)
  }
  return { w: where.length ? where.join(' AND ') : '1=1', args }
}

// 条件に合う求人のID（件数の上限なし。AI検索の対象を決める用途）
export function poolIds(db, q = {}) {
  const { w, args } = buildWhere(q)
  return db.prepare(`SELECT j.id FROM jobs j WHERE ${w} ORDER BY j.id`).all(...args).map((r) => r.id)
}

// 表示用の求人番号（ジョビンズは画面に出る「求人ID」、それ以外は媒体の求人ID）
const REF_NO = `CASE WHEN j.source='jobins' THEN COALESCE((SELECT json_extract(r.raw_json,'$.vacancy_no') FROM job_raw r WHERE r.job_id=j.id), j.source_job_id) ELSE j.source_job_id END AS ref_no`

export function searchJobs(db, q = {}) {
  const { w, args } = buildWhere(q)
  const from = 'jobs j'

  const order = {
    updated: 'j.last_changed_at DESC',
    new: 'j.first_seen_at DESC',
    salary_desc: 'j.salary_max IS NULL, j.salary_max DESC',
    salary_asc: 'j.salary_min IS NULL, j.salary_min ASC',
  }[q.sort || 'updated'] || 'j.last_changed_at DESC'
  const limit = Math.min(Math.max(parseInt(q.limit ?? 20, 10) || 20, 1), 200)
  const offset = Math.max(parseInt(q.offset ?? 0, 10) || 0, 0)

  const ver = JSON.stringify(dataVersion(db))
  if (ver !== cacheVersion) { countCache.clear(); cacheVersion = ver }
  const key = w + '\u0001' + JSON.stringify(args)
  let total = countCache.get(key)
  if (total === undefined) {
    total = db.prepare(`SELECT COUNT(*) AS n FROM ${from} WHERE ${w}`).get(...args).n
    if (countCache.size > 2000) countCache.clear()
    countCache.set(key, total)
  }
  const rows = db.prepare(`SELECT j.*, ${REF_NO}, (SELECT group_concat(feature) FROM job_features f WHERE f.job_id=j.id) AS features_csv
                           FROM ${from} WHERE ${w} ORDER BY ${order} LIMIT ? OFFSET ?`).all(...args, limit, offset)
  for (const r of rows) { r.features = r.features_csv ? r.features_csv.split(',') : []; delete r.features_csv }
  return { total, limit, offset, jobs: rows }
}

// 求人1件の詳細（文章・元データ・都道府県・変更履歴を含む）
export function getJob(db, id) {
  const j = db.prepare(`SELECT * FROM jobs WHERE id=?`).get(Number(id))
  if (!j) return null
  const t = db.prepare(`SELECT description, requirements, benefits FROM job_texts WHERE job_id=?`).get(j.id) || {}
  const r = db.prepare(`SELECT raw_json, detail_json, fetched_at FROM job_raw WHERE job_id=?`).get(j.id) || {}
  const prefs = db.prepare(`SELECT prefecture FROM job_prefectures WHERE job_id=? ORDER BY prefecture`).all(j.id).map((x) => x.prefecture)
  const features = db.prepare(`SELECT feature FROM job_features WHERE job_id=? ORDER BY feature`).all(j.id).map((x) => x.feature)
  const changes = db.prepare(`SELECT change_type, changed_fields, changed_at FROM job_changes
                              WHERE source=? AND source_job_id=? ORDER BY id DESC LIMIT 30`).all(j.source, j.source_job_id)
  const parse = (s) => { try { return s ? JSON.parse(s) : null } catch { return null } }
  return {
    ...j,
    job_categories: parse(j.job_categories_json) || [], industries: parse(j.industries_json) || [],
    experience: parse(j.experience_json) || [], positions: parse(j.positions_json) || [],
    prefectures: prefs, features, ...t,
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
  const features = db.prepare(`SELECT f.feature, COUNT(*) AS n FROM job_features f JOIN jobs j ON j.id=f.job_id
                               WHERE j.status='open' GROUP BY f.feature`).all()
  return { bySource, prefectures: prefs, features, lastRuns: runs, changes24h: changes }
}
