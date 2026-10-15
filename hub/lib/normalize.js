// ============================================================
// 媒体ごとの求人データ（既存アダプタの mapApiJob の出力）→ ハブDBの形 に揃える
// ============================================================
import crypto from 'node:crypto'
import { toBigrams } from './text.js'
import { detectFeatures } from './features.js'

const PREFS = [
  '北海道', '青森県', '岩手県', '宮城県', '秋田県', '山形県', '福島県', '茨城県', '栃木県', '群馬県',
  '埼玉県', '千葉県', '東京都', '神奈川県', '新潟県', '富山県', '石川県', '福井県', '山梨県', '長野県',
  '岐阜県', '静岡県', '愛知県', '三重県', '滋賀県', '京都府', '大阪府', '兵庫県', '奈良県', '和歌山県',
  '鳥取県', '島根県', '岡山県', '広島県', '山口県', '徳島県', '香川県', '愛媛県', '高知県', '福岡県',
  '佐賀県', '長崎県', '熊本県', '大分県', '宮崎県', '鹿児島県', '沖縄県',
]
// 「東京」「大阪」など都府県を省いた表記にも対応（長い名前から先に照合）
const PREF_ALIASES = PREFS.map((p) => [p, p === '北海道' ? p : p.replace(/[都府県]$/, '')])
  .sort((a, b) => b[1].length - a[1].length)

export function extractPrefectures(locations) {
  const found = new Set()
  for (const loc of locations || []) {
    const s = String(loc || '')
    if (!s) continue
    if (/全国|フルリモート|完全在宅/.test(s) && !PREF_ALIASES.some(([, a]) => s.includes(a))) {
      found.add('全国')
      continue
    }
    for (const [full, alias] of PREF_ALIASES) {
      // 「京都」が「東京都」の一部として誤検出されないよう、正式名を優先して照合
      if (s.includes(full)) { found.add(full); continue }
      if (alias !== full && s.includes(alias) && !(alias === '京都' && s.includes('東京都'))) found.add(full)
    }
  }
  return [...found]
}

const arr = (v) => (Array.isArray(v) ? v.filter((x) => x != null && x !== '') : [])
const str = (v) => (v == null ? null : String(v).trim() || null)
const intOrNull = (v) => {
  if (v == null || v === '') return null
  const n = Math.round(Number(v))
  return Number.isFinite(n) ? n : null
}
const numOrNull = (v) => {
  if (v == null || v === '') return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}
const isoOrNull = (v) => {
  if (v == null || v === '') return null
  const t = Date.parse(String(v).replace(' ', 'T'))
  return Number.isFinite(t) ? new Date(t).toISOString() : str(v)
}

// 安定したJSON文字列（キー順を固定）→ ハッシュ用
function stableStringify(v) {
  if (v === undefined) return 'null'
  if (v === null || typeof v !== 'object') return JSON.stringify(v)
  if (Array.isArray(v)) return '[' + v.map(stableStringify).join(',') + ']'
  return '{' + Object.keys(v).sort().map((k) => JSON.stringify(k) + ':' + stableStringify(v[k])).join(',') + '}'
}
export const hashOf = (v) => crypto.createHash('sha1').update(stableStringify(v)).digest('hex')

// 内容比較の対象となる項目（媒体の更新日時は含めない＝日時だけ変わっても「更新」扱いにしない）
export const CONTENT_FIELDS = [
  'title', 'company', 'company_url', 'job_category', 'job_categories_json', 'industry', 'industries_json',
  'employment', 'locations_text', 'salary_min', 'salary_max', 'age_min', 'age_max', 'gender', 'education',
  'overtime', 'holiday', 'experience_json', 'positions_json', 'career_stage',
  'reward_type', 'reward_rate', 'reward_amount', 'reward_text', 'url', 'source_published_at',
  'description', 'requirements', 'benefits', 'prefectures',
]
// ※ features（働き方タグ）は内容ハッシュに含めない。判定ルールを改良したときに
//   全求人が「更新」扱いになるのを避けるため。タグの付け直しは bin/features.js で行う。

// mapApiJob の出力（＋元データ raw）→ ハブの1件分
export function normalizeJob(source, m, raw) {
  if (!m) return null
  const sourceJobId = str(m.sourceJobId)
  if (!sourceJobId) return null
  const locations = arr(m.locations).map(String)
  const reward = m.reward || {}
  const rec = {
    source,
    source_job_id: sourceJobId,
    title: str(m.title),
    company: str(m.company),
    company_url: str(m.companyWebsite),
    job_category: str(m.jobCategory),
    job_categories_json: JSON.stringify(arr(m.jobCategories)),
    industry: str(m.industry),
    industries_json: JSON.stringify(arr(m.industries)),
    employment: str(m.employment),
    locations_text: locations.join(' / ') || null,
    salary_min: intOrNull(m.salaryMin),
    salary_max: intOrNull(m.salaryMax),
    age_min: intOrNull(m.requiredAgeMin),
    age_max: intOrNull(m.requiredAgeMax),
    gender: str(m.requiredGender),
    education: str(m.requiredEducation),
    overtime: str(m.overtime),
    holiday: str(m.holiday),
    experience_json: JSON.stringify(arr(m.experience)),
    positions_json: JSON.stringify(arr(m.positions)),
    career_stage: str(m.careerStage),
    reward_type: str(reward.type),
    reward_rate: numOrNull(reward.rate),
    reward_amount: intOrNull(reward.amount),
    reward_text: str(reward.text),
    url: str(m.url),
    source_published_at: isoOrNull(m.publishStartedAt),
    source_updated_at: isoOrNull(m.lastUpdatedAt),
    description: str(m.description),
    requirements: str(m.requirements),
    benefits: str(m.benefits),
    prefectures: extractPrefectures(locations),
  }
  const rawObj0 = raw ?? m._raw ?? null
  rec.features = detectFeatures(source, { ...rec, experience: arr(m.experience) }, rawObj0)
  const content = {}
  for (const f of CONTENT_FIELDS) content[f] = rec[f] ?? null
  rec.content_hash = hashOf(content)
  const rawObj = raw ?? m._raw ?? null
  rec.raw_json = rawObj == null ? null : JSON.stringify(rawObj)
  rec.raw_hash = rec.raw_json == null ? null : hashOf(rawObj)
  return rec
}

// 全文検索の索引に入れる文字列（2文字単位）
export function ftsColumns(rec) {
  const head = [rec.title, rec.company, rec.job_category, rec.industry, rec.employment, rec.locations_text]
    .filter(Boolean).join(' ')
  const body = [rec.description, rec.requirements, rec.benefits, rec.overtime, rec.holiday, rec.reward_text]
    .filter(Boolean).join(' ')
  return { head: toBigrams(head, 2000), body: toBigrams(body, 6000) }
}
