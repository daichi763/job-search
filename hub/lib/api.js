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
//   GET /api/v1/facets            絞り込みの選択肢（職種・雇用形態・働き方の特徴）
//   GET /api/v1/jobs.csv          検索結果のCSVダウンロード（Excelで開ける）
// ============================================================
import { searchJobs } from './search.js'
import { FEATURES } from './features.js'

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
    features: j.features ?? undefined,
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
    features: db.prepare(`SELECT feature FROM job_features WHERE job_id=? ORDER BY feature`).all(j.id).map((x) => x.feature),
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
function buildQuery(p, { perPage, offset }) {
  const sources = list(p.get('source'))
  for (const s of sources) if (!SOURCES.includes(s)) bad(`source は ${SOURCES.join(' / ')} で指定してください`)
  const feats = list(p.get('features'))
  for (const f of feats) if (!FEATURES[f]) bad(`features は ${Object.keys(FEATURES).join(' / ')} で指定してください`)
  const salaryMin = intParam(p, 'salary_min', { min: 0, max: 100000 })
  const salaryMax = intParam(p, 'salary_max', { min: 0, max: 100000 })
  return {
    keyword: (p.get('q') || '').slice(0, 200),
    source: sources.join(',') || undefined,
    prefecture: list(p.get('prefecture')).join(',') || undefined,
    salaryMin: salaryMin != null ? salaryMin * 10000 : undefined,
    salaryMax: salaryMax != null ? salaryMax * 10000 : undefined,
    age: intParam(p, 'age', { min: 15, max: 100 }) ?? undefined,
    employment: list(p.get('employment')).join(',') || undefined,
    category: list(p.get('category')).join(',') || undefined,
    features: feats.join(',') || undefined,
    excludeKeys: list(p.get('exclude')).join(',') || undefined,
    company: p.get('company') || undefined,
    rewardType: enumParam(p, 'reward_type', ['rate', 'fixed'], undefined),
    changedSince: isoParam(p, 'changed_since') ?? undefined,
    status: enumParam(p, 'status', STATUSES, 'open'),
    sort: enumParam(p, 'sort', SORTS, 'updated'),
    limit: perPage,
    offset,
  }
}

function apiJobs(db, p) {
  const perPage = intParam(p, 'per_page', { min: 1, max: MAX_PER_PAGE }) ?? 20
  const page = intParam(p, 'page', { min: 1 }) ?? 1
  const offset = (page - 1) * perPage
  if (offset > MAX_OFFSET) bad(`${MAX_OFFSET}件目より後は取得できません。条件を絞ってください`)
  const q = buildQuery(p, { perPage, offset })
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

function apiFacets(db) {
  // 職種は媒体ごとに表記がばらばらなので、「・」「/」などで区切った語の出現数上位を返す
  const cat = new Map()
  for (const r of db.prepare(`SELECT job_categories_json AS c, job_category AS s FROM jobs WHERE status='open'`).iterate()) {
    const arr = parseJson(r.c)
    const words = (arr.length ? arr : String(r.s || '').split(/[・/／、,]/)).map((w) => String(w).trim()).filter((w) => w && w.length <= 30)
    for (const w of new Set(words)) cat.set(w, (cat.get(w) || 0) + 1)
  }
  const emp = db.prepare(`SELECT employment AS v, COUNT(*) AS n FROM jobs WHERE status='open' AND employment IS NOT NULL AND employment <> ''
                          GROUP BY employment ORDER BY n DESC LIMIT 30`).all()
  const feats = Object.fromEntries(db.prepare(`SELECT f.feature, COUNT(*) AS n FROM job_features f JOIN jobs j ON j.id=f.job_id
                                               WHERE j.status='open' GROUP BY f.feature`).all().map((r) => [r.feature, r.n]))
  return {
    data: {
      categories: [...cat.entries()].sort((a, b) => b[1] - a[1]).slice(0, 300).map(([value, count]) => ({ value, count })),
      employments: emp.map((r) => ({ value: r.v, count: r.n })),
      features: Object.entries(FEATURES).map(([value, label]) => ({ value, label, count: feats[value] || 0 })),
    },
  }
}

// CSV（Excel で文字化けしないよう UTF-8 BOM 付き）。最大 MAX_CSV 件
export const MAX_CSV = 5000
const CSV_COLUMNS = [
  ['ID', (j) => j.id], ['媒体', (j) => SOURCE_LABELS[j.source] || j.source], ['求人タイトル', (j) => j.title], ['会社名', (j) => j.company],
  ['職種', (j) => j.job_category], ['業種', (j) => j.industry], ['雇用形態', (j) => j.employment], ['勤務地', (j) => j.locations],
  ['年収下限(万円)', (j) => j.salary_min], ['年収上限(万円)', (j) => j.salary_max], ['年齢下限', (j) => j.age_min], ['年齢上限', (j) => j.age_max],
  ['性別条件', (j) => j.gender], ['学歴条件', (j) => j.education], ['経験', (j) => (j.experience || []).join(' / ')],
  ['働き方', (j) => (j.features || []).map((f) => FEATURES[f] || f).join(' / ')],
  ['成果報酬', (j) => j.reward.type === 'rate' && j.reward.rate != null ? `${j.reward.rate}%` : j.reward.type === 'fixed' && j.reward.amount != null ? `${j.reward.amount}万円` : (j.reward.text || '')],
  ['残業', (j) => j.overtime], ['休日', (j) => j.holiday], ['仕事内容', (j) => j.description], ['応募条件', (j) => j.requirements],
  ['媒体URL', (j) => j.url], ['媒体での最終更新', (j) => j.source_updated_at], ['取り込み日時', (j) => j.first_seen_at],
]
const csvCell = (v) => {
  if (v == null) return ''
  let s = String(v).replace(/\r\n?/g, '\n')
  if (/^[=+\-@\t]/.test(s)) s = "'" + s // Excel の数式として実行されるのを防ぐ
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}
function apiJobsCsv(db, p) {
  const limit = intParam(p, 'limit', { min: 1, max: MAX_CSV }) ?? 1000
  const q = buildQuery(p, { perPage: limit, offset: 0 })
  // ID 指定（ids=circus:1,jobins:2）があればその求人だけ（画面で選んだ求人のダウンロード用）
  const ids = list(p.get('ids')).slice(0, MAX_CSV)
  let rows
  if (ids.length) {
    rows = ids.map((k) => getByKey(db, k)).filter(Boolean)
  } else {
    rows = []
    for (let off = 0; off < limit; off += MAX_PER_PAGE) {
      const r = searchJobs(db, { ...q, limit: Math.min(MAX_PER_PAGE, limit - off), offset: off })
      rows.push(...r.jobs)
      if (r.jobs.length < MAX_PER_PAGE) break
    }
  }
  const lines = [CSV_COLUMNS.map((c) => c[0]).join(',')]
  for (const row of rows) {
    const j = jobDetail(db, row)
    lines.push(CSV_COLUMNS.map(([, f]) => csvCell(f(j))).join(','))
  }
  const d = new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 16).replace(/[-:T]/g, '')
  return { status: 200, csv: '\uFEFF' + lines.join('\r\n') + '\r\n', filename: `jobs_${d}.csv` }
}

// ルーティング。戻り値: { status, body } または { status, csv, filename }
export function handleApiV1(db, pathname, params) {
  try {
    let r
    if (pathname === '/api/v1/jobs') r = apiJobs(db, params)
    else if (pathname.startsWith('/api/v1/jobs/')) r = apiJob(db, pathname.slice('/api/v1/jobs/'.length), params)
    else if (pathname === '/api/v1/sources') r = apiSources(db)
    else if (pathname === '/api/v1/prefectures') r = apiPrefectures(db, params)
    else if (pathname === '/api/v1/changes') r = apiChanges(db, params)
    else if (pathname === '/api/v1/facets') r = apiFacets(db)
    else if (pathname === '/api/v1/jobs.csv') return apiJobsCsv(db, params)
    else return { status: 404, body: { error: { code: 'not_found', message: 'このAPIはありません' } } }
    return r.status ? r : { status: 200, body: r }
  } catch (e) {
    if (e instanceof BadRequest) return { status: 400, body: { error: { code: 'bad_request', message: e.message } } }
    throw e
  }
}
