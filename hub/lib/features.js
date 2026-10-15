// ============================================================
// 求人の「働き方の特徴」タグ（リモート・フレックス・副業可 など）
//
//   媒体によって項目の有無・名前がばらばらなので、
//     ① 媒体の元データにある明示的な項目（ヒトリンクの isRemoteOk など）
//     ② 本文・応募条件・福利厚生・休日・元データの文字から判定
//   の2段で付ける。「リモート不可」「副業禁止」のような否定表現は除外する。
//
//   タグは検索の絞り込み用。文章からの判定なので完全ではない
//   （例:「一部リモート」もリモートとして扱う）。
// ============================================================

export const FEATURES = {
  remote: 'リモート可',
  flex: 'フレックス',
  side_job: '副業可',
  no_transfer: '転勤なし',
  holidays_120: '年間休日120日以上',
  weekend_off: '土日祝休み',
  inexperienced_ok: '未経験可',
  short_time: '時短勤務可',
}

// 文字から判定するときの「あり」と「否定」の表現
const RULES = {
  remote: {
    yes: /(フル)?リモート|在宅勤務|在宅ワーク|テレワーク|remote\s?work/i,
    no: /(リモート|在宅勤務|在宅ワーク|テレワーク)(ワーク)?(勤務)?(は|の)?(不可|なし|無し|ありません|できません|NG|対象外)/i,
  },
  flex: {
    yes: /フレックス/,
    no: /フレックス(タイム)?(制度?)?(は|の)?(不可|なし|無し|ありません|導入していません|NG)/,
  },
  side_job: {
    yes: /(副業|兼業|複業)(・兼業)?(は|も)?(OK|ＯＫ|可能?|解禁|歓迎|応相談|認め)/i,
    no: /(副業|兼業|複業)(・兼業)?(は|の)?(不可|禁止|NG|ＮＧ|認めて(い)?ません)/i,
  },
  no_transfer: {
    yes: /転勤(なし|無し|はありません|はございません|は一切ありません|無)|転居を伴う(転勤|異動)(は|の)?(なし|無し|ありません|ございません)/,
    no: /転勤(あり|有り|の可能性)/,
  },
  weekend_off: {
    yes: /土日祝(日)?(休み|休日|休)|完全週休2日制?[（(]土日|土日休み/,
    no: null,
  },
  inexperienced_ok: {
    yes: /(職種|業界|業種)?未経験(者)?(OK|ＯＫ|可|歓迎|大歓迎|からスタート)/i,
    no: /(職種)?未経験(は|者は)?(NG|ＮＧ|不可)/i,
  },
  short_time: {
    yes: /時短(勤務)?(制度)?(あり|可|OK|ＯＫ|可能|導入)/i,
    no: null,
  },
}

// 年間休日の日数を探す（最大値を使う）
function maxAnnualHolidays(text) {
  let max = null
  for (const m of text.matchAll(/年間休日(数)?\s*[:：]?\s*(約|最大)?\s*(\d{2,3})\s*日/g)) {
    const n = parseInt(m[3], 10)
    if (n >= 60 && n <= 200 && (max == null || n > max)) max = n
  }
  return max
}

// 元データの「値」だけを1つの文字列にする（項目名は英語なので判定に使わない）
function rawValuesText(raw, depth = 0, out = []) {
  if (raw == null || depth > 6 || out.length > 4000) return out
  if (typeof raw === 'string') { if (raw.length < 5000) out.push(raw) }
  else if (Array.isArray(raw)) for (const v of raw) rawValuesText(v, depth + 1, out)
  else if (typeof raw === 'object') for (const v of Object.values(raw)) rawValuesText(v, depth + 1, out)
  return out
}

// 媒体の元データにある明示的な項目
function explicitFlags(source, raw) {
  const t = new Set()
  if (!raw || typeof raw !== 'object') return t
  if (source === 'hitolink') {
    if (raw.isRemoteOk === true) t.add('remote')
    if (raw.isFlexibleWorkType === true) t.add('flex')
    if (raw.isSideJobOk === true) t.add('side_job')
    if (raw.isNoRelocation === true) t.add('no_transfer')
    if (raw.hasMoreThan120DaysOff === true) t.add('holidays_120')
    if (raw.dayOffWeekendsHolidays === true) t.add('weekend_off')
    if (raw.noExperienceNecessary === true) t.add('inexperienced_ok')
    if (raw.isReducedHoursOk === true) t.add('short_time')
  }
  if (source === 'circus') {
    // circus の働き方コード（circus_master.js の WORK_ENVIRONMENTS と同じ番号）
    const codes = new Set([].concat(raw.workEnvironments || raw.workEnvironment || []).map(String))
    if (codes.has('1')) t.add('holidays_120')
    if (codes.has('2')) t.add('flex')
    if (codes.has('3')) t.add('short_time')
    if (codes.has('4')) t.add('side_job')
    if (codes.has('5')) t.add('remote')
    if (codes.has('6')) t.add('no_transfer')
    const hol = new Set([].concat(raw.holidays || raw.holiday || []).map(String))
    if (hol.has('1')) t.add('weekend_off')
  }
  return t
}

// rec: normalizeJob の結果（または DB から組み立てた同じ形）、raw: 元データ（オブジェクト）
export function detectFeatures(source, rec, raw) {
  const tags = explicitFlags(source, raw)
  const text = [
    rec.title, rec.job_category, rec.employment, rec.overtime, rec.holiday,
    rec.description, rec.requirements, rec.benefits, rec.reward_text,
    ...(Array.isArray(rec.experience) ? rec.experience : []),
    ...rawValuesText(raw),
  ].filter(Boolean).join('\n').normalize('NFKC')
  for (const [tag, r] of Object.entries(RULES)) {
    if (tags.has(tag)) continue
    if (r.yes.test(text) && !(r.no && r.no.test(text) && !r.yes.test(text.replace(new RegExp(r.no.source, 'gi'), '')))) tags.add(tag)
  }
  if (!tags.has('holidays_120')) {
    const h = maxAnnualHolidays(text)
    if (h != null && h >= 120) tags.add('holidays_120')
  }
  return [...tags].sort()
}
