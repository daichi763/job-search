// ============================================================
// 外部向け検索API v1（別アプリから使う）
//
//   ・URL と項目名は固定（今後の変更は v2 として別に作る）
//   ・年収は「万円」で受け取り・返す（例: salary_min=400 → 400万円以上）
//   ・求人の識別子は "媒体:媒体の求人ID"（例: "circus:12345"）。DBを作り直しても変わらない
//   ・DBは読み取り専用。毎晩の同期以外でデータは変わらない
//
//   GET /api/v1/jobs              検索
//   GET /api/v1/jobs/{id}         求人の詳細
//   GET /api/v1/sources           媒体ごとの件数と最終同期
//   GET /api/v1/prefectures       都道府県ごとの件数
//   GET /api/v1/changes           変更履歴（追加・更新・掲載終了・削除）
// ============================================================
import { searchJobs } from './search.js'

export const SOURCES = ['circus', 'hitolink', 'jobins', 'kintone']
const SOURCE_LABELS = { circus: 'circus', hitolink: 'ヒトリンク', jobins: 'ジョビンズ', kintone: '自社DB（kintone）' }
const SORTS = ['updated', 'new', 'salary_desc', 'salary_asc']
const STATUSES = ['open', 'closed', 'all']
const CHANGE_TYPES = ['added', 'updated', 'closed', 'reopened', 'deleted']
export const MAX_PER_PAGE = 100
export const MAX_OFFSET = 10000 // これより深いページは条件を絞ってもらう（深いページほど遅いため）

class BadRequest extends Error {}
const bad = (m) => { throw new BadRequest(m) }

const man = (yen) => (yen == null ? null : Math.round(yen / 10000))
const parseJson = (s, d = []) => { try { return s ? JSON.parse(s) : d } catch { return d } }
const list = (v) => (v == null || v === '' ? [] : String(v).split(',').map((s) => s.trim()).filter(Boolean))
function intParam(p, name, { min = -Infinity, max = Infinity } = {}) {
  const v = p.get(name)
  if (v == null || v === '') return null
  if (!/^-?\d+$/.test(v)) bad(`${name} は整数で指定してください`)
  const n = parseInt(v, 10)
  if (n < min || n > max) bad(`${name} は ${min}〜${max} の範囲で指定してください`)
  return n
}
function isoParam(p, name) {
  const v = p.get(name)
  if (!v) return null
  const t = Date.parse(v)
  if (!Number.isFinite(t)) bad(`${name} は日時（例: 2026-10-15T00:00:00+09:00）で指定してください`)
  return new Date(t).toISOString()
}
function enumParam(p, name, allowed, def) {
  const v = p.get(name)
  if (v == null || v === '') return def
  if (!allowed.includes(v)) bad(`${name} は ${allowed.join(' / ')} のいずれかで指定してください`)
  return v
}

// 一覧用の求人（短い項目のみ）
export function jobSummary(j) {
  return {
    id: `${j.source}:${j.source_job_id}`,
    source: j.source,
    source_job_id: j.source_job_id,
    status: j.status,
    title: j.title,
    company: j.company,
    job_category: j.job_category,
    job_categories: parseJson(j.job_categories_json),
    industry: j.industry,
    employment: j.employment,
    locations: j.locations_text,
    salary_min: man(j.salary_min),
    salary_max: man(j.salary_max),
    age_min: j.age_min,
    age_max: j.age_max,
    gender: j.gender,
    education: j.education,
    experience: parseJson(j.experience_json),
    reward: { type: j.reward_type, rate: j.reward_rate, amount: man(j.reward_amount), text: j.reward_text },
    url: j.url,
    source_published_at: j.source_published_at,
    source_updated_at: j.source_updated_at,
    first_seen_at: j.first_seen_at,
    last_changed_at: j.last_changed_at,
    closed_at: j.closed_at,
  }
}

function getByKey(db, key) {
  const m = String(key).match(/^([a-z]+):(.+)$/)
  if (!m || !SOURCES.includes(m[1])) return null
  return db.prepare(`SELECT * FROM jobs WHERE source=? AND source_job_id=?`).get(m[1], m[2])
}

export function jobDetail(db, j, { includeRaw = false } = {}) {
  const t = db.prepare(`SELECT description, requirements, benefits FROM job_texts WHERE job_id=?`).get(j.id) || {}
  const prefs = db.prepare(`SELECT prefecture FROM job_prefectures WHERE job_id=? ORDER BY prefecture`).all(j.id).map((x) => x.prefecture)
  const out = {
    ...jobSummary(j),
    company_url: j.company_url,
    industries: parseJson(j.industries_json),
    prefectures: prefs,
    positions: parseJson(j.positions_json),
    career_stage: j.career_stage,
    overtime: j.overtime,
    holiday: j.holiday,
    description: t.description ?? null,
    requirements: t.requirements ?? null,
    benefits: t.benefits ?? null,
    version: j.version,
  }
  if (includeRaw) {
    const r = db.prepare(`SELECT raw_json, detail_json, fetched_at FROM job_raw WHERE job_id=?`).get(j.id) || {}
    out.raw = parseJson(r.raw_json, null)
    out.raw_fetched_at = r.fetched_at ?? null
  }
  return out
}

function dataUpdatedAt(db) {
  return db.prepare(`SELECT MAX(finished_at) AS t FROM sync_runs WHERE status IN ('done','partial')`).get().t
}

// ---- 各API ----
function apiJobs(db, p) {
  const perPage = intParam(p, 'per_page', { min: 1, max: MAX_PER_PAGE }) ?? 20
  const page = intParam(p, 'page', { min: 1 }) ?? 1
  const offset = (page - 1) * perPage
  if (offset > MAX_OFFSET) bad(`${MAX_OFFSET}件目より後は取得できません。条件を絞ってください`)
  const sources = list(p.get('source'))
  for (const s of sources) if (!SOURCES.includes(s)) bad(`source は ${SOURCES.join(' / ')} で指定してください`)
  const salaryMin = intParam(p, 'salary_min', { min: 0, max: 100000 })
  const salaryMax = intParam(p, 'salary_max', { min: 0, max: 100000 })
  const q = {
    keyword: (p.get('q') || '').slice(0, 200),
    source: sources.join(',') || undefined,
    prefecture: list(p.get('prefecture')).join(',') || undefined,
    salaryMin: salaryMin != null ? salaryMin * 10000 : undefined,
    salaryMax: salaryMax != null ? salaryMax * 10000 : undefined,
    age: intParam(p, 'age', { min: 15, max: 100 }) ?? undefined,
    employment: p.get('employment') || undefined,
    category: p.get('category') || undefined,
    company: p.get('company') || undefined,
    rewardType: enumParam(p, 'reward_type', ['rate', 'fixed'], undefined),
    changedSince: isoParam(p, 'changed_since') ?? undefined,
    status: enumParam(p, 'status', STATUSES, 'open'),
    sort: enumParam(p, 'sort', SORTS, 'updated'),
    limit: perPage,
    offset,
  }
  const r = searchJobs(db, q)
  const detail = p.get('fields') === 'full'
  return {
    data: r.jobs.map((j) => (detail ? jobDetail(db, j) : jobSummary(j))),
    meta: { total: r.total, page, per_page: perPage, total_pages: Math.ceil(r.total / perPage), data_updated_at: dataUpdatedAt(db) },
  }
}

function apiJob(db, key, p) {
  const j = getByKey(db, decodeURIComponent(key))
  if (!j) return { status: 404, body: { error: { code: 'not_found', message: '求人が見つかりません（削除済みの可能性があります）' } } }
  return { data: jobDetail(db, j, { includeRaw: p.get('include') === 'raw' }) }
}

function apiSources(db) {
  const counts = Object.fromEntries(db.prepare(`SELECT source, SUM(status='open') AS open, SUM(status='closed') AS closed FROM jobs GROUP BY source`).all().map((r) => [r.source, r]))
  const runs = Object.fromEntries(db.prepare(`SELECT * FROM sync_runs WHERE id IN (SELECT MAX(id) FROM sync_runs WHERE trigger NOT LIKE 'range:%' GROUP BY source)`).all().map((r) => [r.source, r]))
  return {
    data: SOURCES.map((s) => ({
      source: s, label: SOURCE_LABELS[s],
      open: counts[s]?.open ?? 0, closed: counts[s]?.closed ?? 0,
      last_sync: runs[s] ? {
        status: runs[s].status, started_at: runs[s].started_at, finished_at: runs[s].finished_at,
        remote_total: runs[s].remote_total, fetched: runs[s].fetched, complete: !!runs[s].complete,
        added: runs[s].added, updated: runs[s].updated, closed: runs[s].closed, deleted: runs[s].deleted, note: runs[s].close_note,
      } : null,
    })),
    meta: { data_updated_at: dataUpdatedAt(db) },
  }
}

function apiPrefectures(db, p) {
  const sources = list(p.get('source'))
  const where = sources.length ? `AND j.source IN (${sources.map(() => '?').join(',')})` : ''
  return {
    data: db.prepare(`SELECT p.prefecture, COUNT(*) AS count FROM job_prefectures p JOIN jobs j ON j.id=p.job_id
                      WHERE j.status='open' ${where} GROUP BY p.prefecture ORDER BY count DESC`).all(...sources),
  }
}

function apiChanges(db, p) {
  const since = isoParam(p, 'since') ?? new Date(Date.now() - 86400000).toISOString()
  const limit = intParam(p, 'limit', { min: 1, max: 1000 }) ?? 100
  const afterId = intParam(p, 'after_id', { min: 0 }) ?? 0
  const types = list(p.get('type'))
  for (const t of types) if (!CHANGE_TYPES.includes(t)) bad(`type は ${CHANGE_TYPES.join(' / ')} で指定してください`)
  const sources = list(p.get('source'))
  const where = ['changed_at >= ?', 'id > ?']
  const args = [since, afterId]
  if (types.length) { where.push(`change_type IN (${types.map(() => '?').join(',')})`); args.push(...types) }
  if (sources.length) { where.push(`source IN (${sources.map(() => '?').join(',')})`); args.push(...sources) }
  const rows = db.prepare(`SELECT id, source, source_job_id, change_type, changed_fields, changed_at FROM job_changes
                           WHERE ${where.join(' AND ')} ORDER BY id LIMIT ?`).all(...args, limit + 1)
  const more = rows.length > limit
  const data = rows.slice(0, limit).map((r) => ({
    change_id: r.id, id: `${r.source}:${r.source_job_id}`, source: r.source, type: r.change_type,
    changed_fields: parseJson(r.changed_fields, null), changed_at: r.changed_at,
  }))
  return { data, meta: { has_more: more, next_after_id: more ? data[data.length - 1].change_id : null } }
}

// ルーティング。戻り値: { status, body }
export function handleApiV1(db, pathname, params) {
  try {
    let r
    if (pathname === '/api/v1/jobs') r = apiJobs(db, params)
    else if (pathname.startsWith('/api/v1/jobs/')) r = apiJob(db, pathname.slice('/api/v1/jobs/'.length), params)
    else if (pathname === '/api/v1/sources') r = apiSources(db)
    else if (pathname === '/api/v1/prefectures') r = apiPrefectures(db, params)
    else if (pathname === '/api/v1/changes') r = apiChanges(db, params)
    else return { status: 404, body: { error: { code: 'not_found', message: 'このAPIはありません' } } }
    return r.status ? r : { status: 200, body: r }
  } catch (e) {
    if (e instanceof BadRequest) return { status: 400, body: { error: { code: 'bad_request', message: e.message } } }
    throw e
  }
}
