// ============================================================
// AI検索エンジン（求人DB＝hub を全件の母集団として探す）
//
//   段階1 理解   … 要望・書類の経歴から「探し方（切り口）」を作る（優秀モデル）
//                  王道（経験を活かす）／発展（キャリアアップ）／意外（人の手では思いつきにくい隣接領域）
//   段階2 絞込   … 画面で指定した確定条件（勤務地・年齢・年収・雇用形態・働き方…）で
//                  全求人から母集団を作り、切り口のキーワードで関連の強い順に並べる（AI不要・高速）
//   段階3 一次審査 … 安価なモデルで大量に「ざっくり」採点し、有望な求人を残す
//   段階4 精査   … 優秀モデルが求人票の全文と経歴を突き合わせ、
//                  必須要件を1つずつ「満たす／満たさない／不明」で判定する。
//                  満たさない必須要件がある求人は点数に上限をかける（85点問題の対策）
//
//   AIの点数をそのまま使わず、必須要件の判定結果から最終点をプログラムで決める。
// ============================================================
import { buildWhere, jobUrl } from '../search.js'
import { toMatchQuery } from '../text.js'
import { FEATURES } from '../features.js'
import { chatJson, mapLimit, Usage, aiModels } from './llm.js'
import { profileToText, profileBrief } from './profile.js'

const int = (v, d) => { const n = parseInt(v ?? '', 10); return Number.isFinite(n) ? n : d }

// 費用モード: economy（安い）/ standard（既定）/ quality（精度優先）
const COST_MODES = {
  economy:  { screenStandard: 1200, deepFirst: 1.5, deepMaxFactor: 2.5, judgeEffort: 'low',    descChars: 1500 },
  standard: { screenStandard: 2000, deepFirst: 2,   deepMaxFactor: 4,   judgeEffort: 'medium', descChars: 2000 },
  quality:  { screenStandard: 3000, deepFirst: 3,   deepMaxFactor: 6,   judgeEffort: 'high',   descChars: 2800 },
}
export function engineConfig(env = {}, mode) {
  const cm = COST_MODES[mode || env.HUB_AI_COST_MODE] || COST_MODES.standard
  return {
    costMode: COST_MODES[mode || env.HUB_AI_COST_MODE] ? (mode || env.HUB_AI_COST_MODE) : 'standard',
    screenStandard: int(env.HUB_AI_SCREEN_STANDARD, cm.screenStandard), // 標準: 一次審査にかける件数
    screenDeep: int(env.HUB_AI_SCREEN_DEEP, 8000),         // 徹底: 一次審査にかける件数
    screenBatch: int(env.HUB_AI_SCREEN_BATCH, 25),
    deepBatch: int(env.HUB_AI_DEEP_BATCH, 4),
    deepMax: int(env.HUB_AI_DEEP_MAX, 120),                // 精査する最大件数（上限）
    deepFirst: cm.deepFirst,                               // 精査の1回目 = 提案件数 × この倍率
    deepMaxFactor: cm.deepMaxFactor,                       // 精査の最大 = 提案件数 × この倍率（deepMax を超えない）
    judgeEffort: env.HUB_AI_JUDGE_EFFORT || cm.judgeEffort,
    descChars: int(env.HUB_AI_DESC_CHARS, cm.descChars),   // 精査で渡す仕事内容の文字数（応募条件は常に全文）
    deepMinScreen: int(env.HUB_AI_DEEP_MIN_SCREEN, 50),    // 一次審査でこの点以上だけ精査
    concurrency: int(env.HUB_AI_CONCURRENCY, 8),
    capUnmet: int(env.HUB_AI_CAP_UNMET, 55),               // 必須要件を満たさない求人の上限点
    capUnknown: int(env.HUB_AI_CAP_UNKNOWN, 84),           // 書類があるのに必須要件を確認できない求人の上限点
    minScore: int(env.HUB_AI_MIN_SCORE, 60),               // 提案する最低点
    goodScore: int(env.HUB_AI_GOOD_SCORE, 80),             // 「十分に良い」とみなす点（精査の打ち切り判定）
    maxUsd: env.HUB_AI_MAX_USD ? Number(env.HUB_AI_MAX_USD) : null, // 1回の検索の費用上限（米ドル。超えたら精査を打ち切る）
  }
}

// ------------------------------------------------------------
// 学歴・性別の確定判定（AIに任せない）
// ------------------------------------------------------------
const EDU_RANK = { 学歴不問: 0, 中卒: 0, 高卒: 1, 専門卒: 2, 短大卒: 2, 高専卒: 2, 大卒: 3, 大学院卒: 4 }
export function requiredEduRank(text) {
  const s = String(text || '')
  if (!s || /不問/.test(s)) return 0
  if (/大学院|修士|博士/.test(s)) return 4
  if (/大卒|大学卒|学士|四大|4大/.test(s)) return 3
  if (/短大|専門|高専/.test(s)) return 2
  if (/高卒|高校/.test(s)) return 1
  return 0
}
export function eduAllowed(jobEdu, candidateEdu) {
  const c = EDU_RANK[candidateEdu]
  if (c == null) return true
  return requiredEduRank(jobEdu) <= c
}
export function genderAllowed(jobGender, candidateGender) {
  if (!candidateGender || !jobGender) return true
  const g = String(jobGender)
  if (/不問|問わ/.test(g)) return true
  if (candidateGender === '女性' && /男性/.test(g) && !/女性/.test(g)) return false
  if (candidateGender === '男性' && /女性/.test(g) && !/男性/.test(g)) return false
  return true
}

// 画面の確定条件 → hub の検索条件
export function criteriaToQuery(c = {}) {
  const q = { ...(c.filters || {}) } // 手動検索で絞った条件をそのまま引き継ぐ
  q.status = 'open'
  const list = (v) => [].concat(v || []).flatMap((x) => String(x).split(',')).map((x) => x.trim()).filter(Boolean)
  if (list(c.locations).length) q.prefecture = [...new Set([...list(c.locations), ...(c.includeNationwide === false ? [] : ['全国'])])].join(',')
  if (c.salaryMin) q.salaryMin = Number(c.salaryMin) * 10000
  if (c.age) q.age = Number(c.age)
  if (list(c.employment).length) q.employment = list(c.employment).join(',')
  if (list(c.jobCategories).length) q.category = list(c.jobCategories).join(',')
  if (list(c.features).length) q.features = list(c.features).join(',')
  if (list(c.sources).length) q.source = list(c.sources).join(',')
  if (list(c.excludeKeys).length) q.excludeKeys = list(c.excludeKeys).join(',')
  if (list(c.jobKeys).length) q.jobKeys = list(c.jobKeys).join(',')
  return q
}

// 求職者の要望（画面の入力）→ AIに渡す文章
export function criteriaText(c = {}) {
  const L = []
  if (c.freeText) L.push(`【要望（担当者の記入）】\n${c.freeText}`)
  if (c.memo) L.push(`【担当者のメモ】\n${c.memo}`)
  const f = []
  if (c.locations?.length) f.push(`希望勤務地: ${[].concat(c.locations).join('・')}`)
  if (c.salaryMin) f.push(`希望年収: ${c.salaryMin}万円以上`)
  if (c.employment?.length) f.push(`雇用形態: ${[].concat(c.employment).join('・')}`)
  if (c.jobCategories?.length) f.push(`希望職種: ${[].concat(c.jobCategories).join('・')}`)
  if (c.features?.length) f.push(`働き方: ${[].concat(c.features).map((x) => FEATURES[x] || x).join('・')}`)
  if (c.overtimeMax) f.push(`残業: ${c.overtimeMax}`)
  if (c.holiday?.length) f.push(`休日: ${[].concat(c.holiday).join('・')}`)
  if (c.age) f.push(`年齢: ${c.age}歳`)
  if (c.gender) f.push(`性別: ${c.gender}`)
  if (c.education) f.push(`最終学歴: ${c.education}`)
  if (f.length) L.push(`【確定条件】${f.join(' / ')}`)
  return L.join('\n')
}

// ------------------------------------------------------------
// 段階1: 理解 → 探し方の計画
// ------------------------------------------------------------
const PLAN_SYSTEM = `あなたは人材紹介会社のトップキャリアアドバイザーです。
求職者の要望と経歴を読み解き、数十万件の求人データベースから「この人に本当に合う求人」を探すための計画を作ります。
担当者が手作業では時間がかかって見つけられない、気の利いた提案ができるように考えてください。

【切り口（angles）の作り方】3〜6個。種類を混ぜる:
- 王道: 経験・スキルをそのまま活かせる求人
- 発展: 経験を土台にしたキャリアアップ（上位職・専門職・年収アップ）
- 意外: 本人が想定していないかもしれないが、経験やスキルが評価される隣接領域・別業界
 ※ 要望と矛盾する切り口は作らない（例: 営業はもう嫌と書いてあるのに営業職を出さない）。
【keywords】各切り口に3〜10語。求人票の本文に実際に書かれていそうな短い語（2〜10文字）にする。
 職種名・業務名・業界名・スキル名・資格名など。長い文やNOT条件は書かない。
【priorities】要望から読み取れる重視点（重要な順）。
【dealbreakers】避けたい条件（要望や書類から明確に読み取れるものだけ。例: 転勤、夜勤、飛び込み営業）。
【mustHave】求人が満たすべき条件のうち、確定条件以外で要望から明確なもの（例: 土日休み必須）。

必ず次のJSONだけを返す:
{"understanding":"要望と経歴の解釈（200字程度）",
 "priorities":["..."], "dealbreakers":["..."], "mustHave":["..."],
 "angles":[{"type":"王道|発展|意外","label":"切り口の名前（25字以内）","why":"この人に合う理由（60字以内）","keywords":["..."]}]}`

export async function makePlan(env, ctx) {
  const user = [criteriaText(ctx.criteria), ctx.profileText ? `\n【書類から読み取った経歴】\n${ctx.profileText}` : '\n（書類なし）'].join('\n')
  const { data, model } = await chatJson(env, { models: ctx.models.smartList, system: PLAN_SYSTEM, user, effort: 'medium', maxTokens: 6000, usage: ctx.usage, label: '要望の理解' })
  const angles = (Array.isArray(data.angles) ? data.angles : []).map((a, i) => ({
    id: i, type: ['王道', '発展', '意外'].includes(a.type) ? a.type : '王道',
    label: String(a.label || `切り口${i + 1}`).slice(0, 40), why: String(a.why || '').slice(0, 120),
    keywords: [...new Set((a.keywords || []).map((k) => String(k).trim()).filter((k) => k.length >= 2 && k.length <= 20))].slice(0, 12),
  })).filter((a) => a.keywords.length)
  return {
    model,
    understanding: String(data.understanding || ''),
    priorities: (data.priorities || []).map(String).slice(0, 10),
    dealbreakers: (data.dealbreakers || []).map(String).slice(0, 10),
    mustHave: (data.mustHave || []).map(String).slice(0, 10),
    angles,
  }
}

// ------------------------------------------------------------
// 段階2: 母集団（確定条件）→ 関連の強い順
// ------------------------------------------------------------
const ANGLE_WEIGHT = { 王道: 1.0, 発展: 0.85, 意外: 0.7 }
function ftsHits(db, phrase, headOnly) {
  try {
    return db.prepare(`SELECT rowid FROM jobs_fts WHERE jobs_fts MATCH ?`).all(headOnly ? `head : ${phrase}` : phrase).map((r) => r.rowid)
  } catch { return [] }
}

export function buildPool(db, criteria) {
  const q = criteriaToQuery(criteria)
  const { w, args } = buildWhere(q)
  const rows = db.prepare(`SELECT j.id, j.education, j.gender FROM jobs j WHERE ${w}`).all(...args)
  let excludedEdu = 0, excludedGender = 0
  const ids = []
  for (const r of rows) {
    if (!eduAllowed(r.education, criteria.education)) { excludedEdu++; continue }
    if (!genderAllowed(r.gender, criteria.gender)) { excludedGender++; continue }
    ids.push(r.id)
  }
  return { ids, query: q, excluded: { education: excludedEdu, gender: excludedGender } }
}

// 切り口ごとに関連度を付ける。戻り値: Map(id → { total, byAngle: number[] })
export function rankPool(db, poolIds, angles, extraKeywords = []) {
  const pool = new Set(poolIds)
  const score = new Map()
  const bump = (id, ai, v) => {
    let s = score.get(id)
    if (!s) { s = { total: 0, byAngle: new Array(angles.length).fill(0) }; score.set(id, s) }
    s.total += v
    if (ai >= 0) s.byAngle[ai] += v
  }
  const termCache = new Map()
  const termHits = (kw) => {
    if (termCache.has(kw)) return termCache.get(kw)
    const { match } = toMatchQuery(kw)
    let r = null
    if (match && !match.includes(' AND ')) {
      const all = ftsHits(db, match, false)
      const head = new Set(ftsHits(db, match, true))
      // 多くの求人に出てくるありふれた語は効きを弱める
      const idf = Math.log(1 + 400000 / (1 + all.length)) / Math.log(400001)
      r = { all, head, idf: Math.max(0.15, idf) }
    }
    termCache.set(kw, r)
    return r
  }
  angles.forEach((a, ai) => {
    const wA = ANGLE_WEIGHT[a.type] || 0.8
    for (const kw of a.keywords) {
      const h = termHits(kw)
      if (!h) continue
      for (const id of h.all) if (pool.has(id)) bump(id, ai, wA * h.idf * (h.head.has(id) ? 3 : 1))
    }
  })
  for (const kw of extraKeywords) {
    const h = termHits(kw)
    if (!h) continue
    for (const id of h.all) if (pool.has(id)) bump(id, -1, 0.3 * h.idf * (h.head.has(id) ? 2 : 1))
  }
  return score
}

// 一次審査にかける求人を選ぶ
//   ・切り口ごとの上位を均等に（60%）
//   ・関連度の合計が高い順（残りの大半）
//   ・職種ごとに少しずつ（15%）… キーワードに当たらない職種にも「意外な求人」が眠っているため
export function pickForScreening(poolIds, score, angles, limit, categoryOf = null) {
  const byTotal = (a, b) => (score.get(b)?.total || 0) - (score.get(a)?.total || 0) || b - a
  if (poolIds.length <= limit) return [...poolIds].sort(byTotal)
  const chosen = new Set()
  const perAngle = angles.length ? Math.floor((limit * 0.6) / angles.length) : 0
  const scored = [...score.entries()]
  angles.forEach((_, ai) => {
    scored.filter(([, s]) => s.byAngle[ai] > 0).sort((x, y) => y[1].byAngle[ai] - x[1].byAngle[ai])
      .slice(0, perAngle).forEach(([id]) => chosen.add(id))
  })
  const strataSlots = categoryOf ? Math.floor(limit * 0.15) : 0
  for (const [id] of scored.sort((x, y) => y[1].total - x[1].total)) {
    if (chosen.size >= limit - strataSlots) break
    chosen.add(id)
  }
  if (categoryOf) {
    const groups = new Map()
    for (const id of [...poolIds].sort(byTotal)) {
      if (chosen.has(id)) continue
      const c = categoryOf(id) || '不明'
      if (!groups.has(c)) groups.set(c, [])
      groups.get(c).push(id)
    }
    const lists = [...groups.values()]
    for (let k = 0; chosen.size < limit && lists.some((l) => l.length > k); k++) {
      for (const l of lists) { if (chosen.size >= limit) break; if (l[k] != null) chosen.add(l[k]) }
    }
  }
  if (chosen.size < limit) for (const id of [...poolIds].sort((a, b) => b - a)) { if (chosen.size >= limit) break; chosen.add(id) }
  return [...chosen].sort(byTotal)
}

// 職種のおおまかな区分（層別の枠に使う。職種名の先頭の語）
function categoryLookup(db, ids) {
  const m = new Map()
  const st = db.prepare(`SELECT id, job_category FROM jobs WHERE id IN (SELECT value FROM json_each(?))`)
  for (let i = 0; i < ids.length; i += 20000) {
    for (const r of st.all(JSON.stringify(ids.slice(i, i + 20000)))) m.set(r.id, String(r.job_category || '').split(/[・/／、,＞>\s（(]/)[0].slice(0, 12))
  }
  return (id) => m.get(id)
}

// 同じ求人（媒体違い・同じ会社の同じ募集）をまとめるための目印
const normCo = (s) => String(s || '').normalize('NFKC').replace(/株式会社|有限会社|合同会社|\(株\)|（株）|\s/g, '').toLowerCase()
const normTitle = (s) => String(s || '').normalize('NFKC').replace(/[【\[（(].*?[】\]）)]|[^\p{L}\p{N}]/gu, '').slice(0, 14).toLowerCase()
export function dupKey(j) { const c = normCo(j.company); return c ? `${c}|${normTitle(j.title)}` : null }

// ------------------------------------------------------------
// 求人の読み込み
// ------------------------------------------------------------
const man = (y) => (y == null ? '?' : Math.round(y / 10000))
function loadJobs(db, ids, { full }) {
  if (!ids.length) return []
  const out = []
  for (let i = 0; i < ids.length; i += 500) {
    const part = ids.slice(i, i + 500)
    const rows = db.prepare(`SELECT j.*, t.description, t.requirements, t.benefits,
        (SELECT group_concat(feature) FROM job_features f WHERE f.job_id=j.id) AS features_csv,
        CASE WHEN j.source='jobins' THEN (SELECT json_extract(r.raw_json,'$.vacancy_no') FROM job_raw r WHERE r.job_id=j.id) END AS vacancy_no,
        CASE WHEN j.source='jobins' THEN (SELECT json_extract(r.raw_json,'$.encrypted_vacancy_no') FROM job_raw r WHERE r.job_id=j.id) END AS enc_no
      FROM jobs j LEFT JOIN job_texts t ON t.job_id=j.id WHERE j.id IN (${part.map(() => '?').join(',')})`).all(...part)
    const byId = new Map(rows.map((r) => [r.id, r]))
    for (const id of part) if (byId.has(id)) out.push(byId.get(id))
  }
  for (const r of out) {
    r.features = r.features_csv ? r.features_csv.split(',') : []
    if (r.enc_no) r.url = jobUrl('jobins', r.url, { encrypted_vacancy_no: r.enc_no })
  }
  return out
}
const oneLine = (s, n) => String(s || '').replace(/\s+/g, ' ').trim().slice(0, n)

// 一次審査用の短い要約（1件あたり約250字。大量に送るため、判断に効く項目だけ）
//   ・応募条件は先頭の必須部分（「歓迎」以降は落とす）
//   ・仕事内容は冒頭だけ
function reqHead(s, n) {
  const t = oneLine(s, 600)
  const cut = t.search(/【?(歓迎|尚可|あれば尚|優遇)/)
  return (cut > 20 ? t.slice(0, cut) : t).slice(0, n)
}
export function jobBrief(j, { req = 130, desc = 70 } = {}) {
  return [
    oneLine(j.title, 60), j.company ? oneLine(j.company, 20) : '', j.job_category ? oneLine(j.job_category, 30) : '',
    (j.salary_min || j.salary_max) ? `${man(j.salary_min)}-${man(j.salary_max)}万` : '',
    j.employment && !/正社員/.test(j.employment) ? oneLine(j.employment, 10) : '',
    j.features.length ? j.features.map((f) => FEATURES[f] || f).join('・') : '',
    j.requirements ? `必須:${reqHead(j.requirements, req)}` : '', j.description ? `内容:${oneLine(j.description, desc)}` : '',
  ].filter(Boolean).join('/')
}

function jobFull(j, descChars = 2800) {
  const L = [
    `タイトル: ${oneLine(j.title, 200)}`,
    `会社: ${oneLine(j.company, 80)}${j.industry ? ` / 業種: ${oneLine(j.industry, 80)}` : ''}`,
    `職種: ${oneLine(j.job_category, 150)}`,
    `雇用形態: ${j.employment || '不明'} / 勤務地: ${oneLine(j.locations_text, 200) || '不明'}`,
    `想定年収: ${(j.salary_min || j.salary_max) ? `${man(j.salary_min)}〜${man(j.salary_max)}万円` : '不明'}`,
    `応募条件（確定項目）: 年齢 ${j.age_min ?? ''}〜${j.age_max ?? ''}${j.age_min == null && j.age_max == null ? '指定なし' : '歳'} / 性別 ${j.gender || '不問'} / 学歴 ${j.education || '不問'}`,
    j.features.length ? `働き方: ${j.features.map((f) => FEATURES[f] || f).join('・')}` : '',
    j.overtime ? `残業: ${oneLine(j.overtime, 150)}` : '', j.holiday ? `休日: ${oneLine(j.holiday, 200)}` : '',
    `【応募条件・必須要件（全文）】\n${String(j.requirements || '記載なし').slice(0, 3500)}`,
    `【仕事内容】\n${String(j.description || '記載なし').slice(0, descChars)}`,
    j.benefits ? `【待遇・その他】${oneLine(j.benefits, 400)}` : '',
  ]
  return L.filter(Boolean).join('\n')
}

// ------------------------------------------------------------
// 段階3: 一次審査（安価なモデルで大量に）
// ------------------------------------------------------------
const SCREEN_SYSTEM = `あなたは人材紹介のプロです。数多くの求人から、求職者に推薦する価値のある求人を「ふるい分け」ます。
求人ごとに次の3つを判定してください。甘く付けず、差をはっきり付けること。
 g … 総合評価 1〜5
     5 = 要望の中心（やりたいこと・重視点）に直接合い、経歴も活きる。真っ先に提案したい
     4 = 要望によく合う。経歴も活きる
     3 = 一部は合うが、要望の中心からは外れる／特徴が乏しい
     2 = 要望とのずれが大きい
     1 = 合わない（避けたい条件に当たる・職種違い・必須要件を明らかに満たさない）
 w … 要望の中心（求職者が「やりたい」と言っていること）に沿う仕事か: 1=沿う 0=沿わない
 r … 必須要件（経験年数・資格など）: 1=満たしそう 0=明らかに満たさない 2=判断できない
 ※「経験を活かせる」だけで要望の中心から外れる求人は g=3 以下にする。
 ※ 同じような求人が並んでも、要望の中心に沿うものを優先して高くする。
必ず次のJSONだけを返す: {"s":[[番号,g,w,r],...]}`

function contextBlock(ctx, { short }) {
  const p = ctx.plan
  const L = [criteriaText(ctx.criteria)]
  if (p?.understanding) L.push(`【AIの解釈】${p.understanding}`)
  if (p?.priorities?.length) L.push(`【重視点】${p.priorities.join(' / ')}`)
  if (p?.mustHave?.length) L.push(`【要望上の必須】${p.mustHave.join(' / ')}`)
  if (p?.dealbreakers?.length) L.push(`【避けたい条件】${p.dealbreakers.join(' / ')}`)
  if (p?.angles?.length) L.push(`【探す切り口】${p.angles.map((a) => `${a.type}:${a.label}`).join(' / ')}`)
  if (ctx.profileText) L.push(`【求職者の経歴】\n${short ? (ctx.profileBrief || ctx.profileText.slice(0, 1200)) : ctx.profileText}`)
  else L.push('【求職者の経歴】書類なし（要望と確定条件だけで判断する）')
  return L.join('\n')
}

// 1〜5 の評価・要望の中心・必須要件 → 0〜100 の一次審査点
export function screenPoint(g, w, r) {
  const base = { 5: 90, 4: 75, 3: 55, 2: 35, 1: 10 }[Math.max(1, Math.min(5, Math.round(Number(g) || 3)))]
  let p = base + (Number(w) === 1 ? 5 : -10)
  if (Number(r) === 0) p = Math.min(p, 30)
  return Math.max(0, Math.min(100, p))
}

async function screenJobs(env, ctx, jobs, onBatch) {
  const cfg = ctx.cfg
  const head = contextBlock(ctx, { short: true })
  const batches = []
  for (let i = 0; i < jobs.length; i += cfg.screenBatch) batches.push(jobs.slice(i, i + cfg.screenBatch))
  const scores = new Map()
  let done = 0
  const ask = async (batch) => {
    const lines = batch.map((j, i) => `[${i}] ${jobBrief(j)}`).join('\n')
    const { data } = await chatJson(env, {
      models: ctx.models.fastList, system: SCREEN_SYSTEM, effort: ctx.screenEffort || 'low', maxTokens: 4000, usage: ctx.usage, label: '一次審査',
      user: `${head}\n\n【求人（${batch.length}件。[0]〜[${batch.length - 1}] のすべてに回答する）】\n${lines}`,
    })
    const got = new Map()
    for (const row of Array.isArray(data.s) ? data.s : []) {
      if (!Array.isArray(row)) continue
      const [i, g, w, r] = row
      if (batch[i] && g != null) got.set(batch[i].id, screenPoint(g, w, r))
    }
    return got
  }
  await mapLimit(batches, cfg.concurrency, async (batch) => {
    if (ctx.isCancelled?.()) return
    let rest = batch
    // 回答が抜けた求人だけを、最大2回まで聞き直す
    for (let round = 0; round < 3 && rest.length; round++) {
      try {
        const got = await ask(rest)
        for (const [k, v] of got) scores.set(k, v)
      } catch (e) {
        ctx.log?.(`一次審査の一部に失敗: ${e.message}`)
      }
      rest = rest.filter((j) => !scores.has(j.id))
    }
    if (rest.length) ctx.log?.(`一次審査で回答が得られなかった求人 ${rest.length}件は50点扱い`)
    for (const j of rest) scores.set(j.id, 50)
    done += batch.length
    onBatch?.(done, jobs.length)
  })
  return scores
}

// 評価用: 一次審査の判断理由を見る
export async function _explainForTest(env, db, criteria, profile, plan, ids) {
  const m = aiModels(env)
  const ctx = { criteria, plan, profileText: profileToText(profile) }
  const jobs = loadJobs(db, ids, {})
  const user = `${contextBlock(ctx, { short: true })}\n\n【求人】\n${jobs.map((j, i) => `[${i}] ${jobBrief(j)}`).join('\n')}`
  const { data } = await chatJson(env, { models: [m.fast], system: SCREEN_SYSTEM.replace('{"s":[[番号,g,w,r],...]}', '{"s":[[番号,g,w,r,"判断理由30字"],...]}'), user, effort: 'low', maxTokens: 4000 })
  return { user, data }
}

// 評価用: 一次審査だけを実行する
export async function _screenForTest(env, db, criteria, profile, plan, ids, effort, log) {
  const m = aiModels(env)
  const ctx = { criteria, cfg: engineConfig(env), usage: new Usage(), plan, log, profileText: profileToText(profile), screenEffort: effort,
    models: { fastList: [m.fast, ...m.fallbackFast] } }
  const r = await screenJobs(env, ctx, loadJobs(db, ids, { full: false }))
  return r
}

// ------------------------------------------------------------
// 段階4: 精査（必須要件を1つずつ判定）
// ------------------------------------------------------------
const DEEP_SYSTEM = `あなたは人材紹介会社の熟練キャリアアドバイザーです。求職者に本当に推薦できる求人かを厳密に審査します。
求人票の全文と求職者の経歴を突き合わせ、次を判定してください（推薦文はこの段階では書かない）。

1. 求人票から「必須要件」をすべて抜き出し、1つずつ判定する（must）
   - 必須要件 = 「必須」「要」「〜以上」「〜をお持ちの方」「経験者のみ」など応募に必要な条件。
     経験年数・職種経験・資格・免許・スキル・語学・マネジメント経験・学歴・年齢・性別など。
   - 「歓迎」「尚可」「あれば」「優遇」は必須ではないので must に入れない。
   - 「未経験歓迎」「学歴不問」など条件を緩める記載は要件ではない。
   - status:
     met     … 経歴の事実・確定条件から満たすと言える（evidence に根拠）
     unmet   … 経歴の事実・確定条件から満たさないと言える（例: 「営業経験3年以上」に対し営業1年）
     unknown … 情報がなく判断できない
   - 経験年数は「職種別の経験年数」「職歴の期間」で照合する。似た職種は内容で判断する（例: ルート営業も法人営業経験に含みうる）。
   - 書類がない場合、経歴に関わる要件は unknown にする（要望欄の自己申告だけでは met にしない）。
   - 都合よく解釈しない。根拠のない met は禁止。
   - req と evidence はそれぞれ30字以内で簡潔に。
2. score（0〜100）: 必須要件を満たす前提で、要望（重視点・避けたい条件・確定条件）と経歴にどれだけ合うか。
   90以上=迷わず推薦 / 80台=強く推薦 / 70台=推薦できる / 60台=条件付き / 60未満=推薦しない
3. angle: 王道=経験そのまま / 発展=キャリアアップ / 意外=隣接領域で経験が活きる
4. fit: 要望との合致点と最大の懸念を40字以内で

必ず次のJSONだけを返す:
{"r":[{"i":0,"must":[{"req":"要件","status":"met|unmet|unknown","evidence":"根拠"}],"angle":"王道|発展|意外","score":82,"fit":"..."}]}`

const WRITE_SYSTEM = `あなたは人材紹介会社の熟練キャリアアドバイザーです。審査済みの求人について、求職者に提案する文章を書きます。
各求人について次を書いてください。
- reason: 求職者本人に提案する想定の丁寧な日本語（180〜240字）。なぜこの人に合うのかを、要望と経歴に具体的に結びつける。必須要件の判定（○×？）と矛盾しないこと。
- concerns: 懸念点（要望と合わない点など）。最大3つ、各40字以内。無ければ空配列。
- checkPoints: 応募前に担当者が求職者や企業に確認すべきこと。「？」の必須要件を優先。最大3つ、各40字以内。
必ず次のJSONだけを返す: {"r":[{"i":0,"reason":"...","concerns":["..."],"checkPoints":["..."]}]}`

export function finalizeScore(r, { hasProfile, cfg }) {
  const must = Array.isArray(r.must) ? r.must : []
  const unmet = must.filter((m) => m.status === 'unmet')
  const unknown = must.filter((m) => m.status === 'unknown')
  let score = Math.max(0, Math.min(100, Math.round(Number(r.score) || 0)))
  const raw = score
  let capped = null
  if (unmet.length) { if (score > cfg.capUnmet) { score = cfg.capUnmet; capped = 'unmet' } }
  else if (unknown.length && hasProfile) { if (score > cfg.capUnknown) { score = cfg.capUnknown; capped = 'unknown' } }
  const eligibility = unmet.length ? 'unmet' : unknown.length ? 'unknown' : 'met'
  return { score, rawScore: raw, capped, eligibility, unmetCount: unmet.length, unknownCount: unknown.length }
}

const STATUS = ['met', 'unmet', 'unknown']
async function deepJudge(env, ctx, jobs, onBatch) {
  const cfg = ctx.cfg
  const head = contextBlock(ctx, { short: false })
  const batches = []
  for (let i = 0; i < jobs.length; i += cfg.deepBatch) batches.push(jobs.slice(i, i + cfg.deepBatch))
  const results = []
  let done = 0
  await mapLimit(batches, Math.max(2, Math.ceil(cfg.concurrency / 2)), async (batch) => {
    if (ctx.isCancelled?.()) return
    const body = batch.map((j, i) => `===== 求人[${i}] =====\n${jobFull(j, cfg.descChars)}`).join('\n\n')
    let arr = []
    try {
      const { data, model } = await chatJson(env, {
        models: ctx.models.deepList, system: DEEP_SYSTEM, effort: ctx.precision === 'top' ? 'high' : cfg.judgeEffort,
        maxTokens: 3000 + 1500 * batch.length, usage: ctx.usage, label: '精査', stage: '精査（判定）',
        user: `${head}\n\n${body}\n\n各求人[i]を審査してJSONで返してください。`,
      })
      arr = (Array.isArray(data.r) ? data.r : Array.isArray(data.results) ? data.results : []).map((x) => ({ ...x, _model: model }))
    } catch (e) {
      ctx.log?.(`精査の一部に失敗（${batch.length}件）: ${e.message}`)
    }
    for (let i = 0; i < batch.length; i++) {
      const r = arr.find((x) => Number(x.i) === i)
      if (!r) continue
      const fin = finalizeScore(r, { hasProfile: !!ctx.profileText, cfg })
      const item = {
        job: batch[i], ...fin,
        must: (r.must || []).slice(0, 15).map((m) => ({ req: String(m.req || '').slice(0, 120), status: STATUS.includes(m.status) ? m.status : 'unknown', evidence: String(m.evidence || '').slice(0, 160) })),
        fit: String(r.fit || '').slice(0, 120), angle: ['王道', '発展', '意外'].includes(r.angle) ? r.angle : null,
        reason: '', concerns: [], checkPoints: [], model: r._model,
      }
      results.push(item)
      ctx.onJudged?.(item)
    }
    done += batch.length
    onBatch?.(done, jobs.length)
  })
  return results
}

// 提案に残った求人だけ、推薦文・懸念・確認事項を書く（全件に書くと費用の大半を占めるため）
function jobForWriting(j, r) {
  const mark = { met: '○', unmet: '×', unknown: '？' }
  return [
    `タイトル: ${oneLine(j.title, 120)} / 会社: ${oneLine(j.company, 60)}`,
    `勤務地: ${oneLine(j.locations_text, 100) || '不明'} / 年収: ${(j.salary_min || j.salary_max) ? `${man(j.salary_min)}〜${man(j.salary_max)}万円` : '不明'} / 雇用形態: ${j.employment || '不明'}`,
    j.features.length ? `働き方: ${j.features.map((f) => FEATURES[f] || f).join('・')}` : '',
    `必須要件の判定: ${r.must.map((m) => `${mark[m.status]}${m.req}（${m.evidence}）`).join(' / ') || 'なし'}`,
    `審査メモ: ${r.fit} / 位置づけ: ${r.angle || '-'} / 点数: ${r.score}`,
    `応募条件: ${oneLine(j.requirements, 900)}`,
    `仕事内容: ${oneLine(j.description, 900)}`,
  ].filter(Boolean).join('\n')
}
async function writeReasons(env, ctx, items) {
  if (!items.length) return
  const head = contextBlock(ctx, { short: true })
  const batches = []
  for (let i = 0; i < items.length; i += 5) batches.push(items.slice(i, i + 5))
  await mapLimit(batches, Math.max(2, Math.ceil(ctx.cfg.concurrency / 2)), async (batch) => {
    try {
      const { data } = await chatJson(env, {
        models: ctx.models.writeList || ctx.models.smartList, system: WRITE_SYSTEM, effort: 'low', maxTokens: 1500 + 700 * batch.length, usage: ctx.usage,
        label: '推薦文', stage: '推薦文',
        user: `${head}\n\n${batch.map((r, i) => `===== 求人[${i}] =====\n${jobForWriting(r.job, r)}`).join('\n\n')}\n\n各求人[i]の推薦文をJSONで返してください。`,
      })
      for (const x of Array.isArray(data.r) ? data.r : []) {
        const r = batch[Number(x.i)]
        if (!r) continue
        r.reason = String(x.reason || '').slice(0, 400)
        r.concerns = (x.concerns || []).map(String).slice(0, 3)
        r.checkPoints = (x.checkPoints || []).map(String).slice(0, 3)
      }
    } catch (e) {
      ctx.log?.(`推薦文の作成に一部失敗: ${e.message}`)
    }
    for (const r of batch) if (!r.reason) r.reason = r.fit
  })
}

// 精査する求人を選ぶ
//   一次審査の点数順だけだと、似た求人（同じ切り口）で枠が埋まる。
//   そこで、まず切り口ごとに上位を枠として確保し、残りを点数順で埋める。
export function pickForDeep(ids, screen, score, angles, n, minScreen) {
  const sortKey = (a, b) => screen.get(b) - screen.get(a) || (score.get(b)?.total || 0) - (score.get(a)?.total || 0)
  const ok = ids.filter((id) => (screen.get(id) ?? 0) >= minScreen).sort(sortKey)
  const chosen = new Set()
  const main = (id) => { const s = score.get(id); if (!s || !s.byAngle.some((x) => x > 0)) return -1; return s.byAngle.indexOf(Math.max(...s.byAngle)) }
  // 切り口ごとの枠（合計で全体の6割まで）。順番に1件ずつ取り、特定の切り口が枠を独占しないようにする
  const per = angles.length ? Math.max(1, Math.floor((n * 0.6) / angles.length)) : 0
  const lanes = angles.map((_, ai) => ok.filter((id) => main(id) === ai).slice(0, per))
  // 各切り口の上位3件は、精査の1回目に必ず入るよう先頭に置く
  const early = []
  for (let k = 0; k < Math.min(per, 3); k++) for (const l of lanes) if (l[k] != null && !chosen.has(l[k]) && chosen.size < n) { chosen.add(l[k]); early.push(l[k]) }
  for (let k = 3; k < per; k++) for (const l of lanes) if (l[k] != null && chosen.size < n) chosen.add(l[k])
  for (const id of ok) { if (chosen.size >= n) break; chosen.add(id) }
  const rest = [...chosen].filter((id) => !early.includes(id)).sort(sortKey)
  // 先頭: 一次審査の上位を少し + 切り口ごとの代表 → そのあと点数順
  const head = rest.slice(0, Math.max(0, Math.ceil(n / 4) - early.length))
  return [...early, ...head, ...rest.slice(head.length)].slice(0, n)
}

// ------------------------------------------------------------
// 全体の実行
//   criteria: 画面の条件（freeText, memo, locations, salaryMin, age, gender, education,
//             employment, jobCategories, features, sources, excludeKeys, jobKeys, filters, topN）
//   options : { profile, depth: standard|deep|all, precision: high|top, onProgress, onJudged, isCancelled, log }
// ------------------------------------------------------------
export async function runAiSearch(env, db, criteria, options = {}) {
  const cfg = { ...engineConfig(env, options.costMode), ...(options.config || {}) }
  const m = aiModels(env)
  const precision = options.precision === 'top' ? 'top' : 'high'
  const ctx = {
    criteria, cfg, precision, usage: new Usage(), log: options.log, onJudged: options.onJudged, isCancelled: options.isCancelled,
    profileText: options.profileText || profileToText(options.profile),
    profileBrief: options.profile ? profileBrief(options.profile) : null,
    models: {
      smartList: [m.smart, ...m.fallbackSmart],
      deepList: precision === 'top' ? [m.top, m.smart, ...m.fallbackSmart] : [m.smart, ...m.fallbackSmart],
      fastList: [m.fast, ...m.fallbackFast],
      writeList: m.write ? [m.write, m.smart, ...m.fallbackSmart] : [m.smart, ...m.fallbackSmart],
    },
  }
  const t0 = Date.now()
  const progress = (stage, message, extra = {}) => options.onProgress?.({ stage, message, elapsedSec: Math.round((Date.now() - t0) / 1000), usage: ctx.usage.summary(), ...extra })
  const topN = Math.max(1, Math.min(100, Number(criteria.topN) || 20))

  // 段階1
  progress('plan', '要望と経歴を読み解いています…')
  ctx.plan = await makePlan(env, ctx)
  progress('plan', `探し方を決めました（切り口 ${ctx.plan.angles.length}つ）`, { plan: ctx.plan })

  // 段階2
  const pool = buildPool(db, criteria)
  const extra = []
  if (options.profile?.keywords) extra.push(...options.profile.keywords.map(String).filter((k) => k.length >= 2).slice(0, 30))
  const score = rankPool(db, pool.ids, ctx.plan.angles, extra)
  const depth = criteria.jobKeys?.length ? 'all' : (options.depth || 'standard')
  const limit = depth === 'all' ? pool.ids.length : depth === 'deep' ? cfg.screenDeep : cfg.screenStandard
  const screenIds = pickForScreening(pool.ids, score, ctx.plan.angles, limit, pool.ids.length > limit ? categoryLookup(db, pool.ids) : null)
  progress('pool', `確定条件に合う求人 ${pool.ids.length.toLocaleString()}件のうち、関連の強い ${screenIds.length.toLocaleString()}件を審査します`, {
    poolSize: pool.ids.length, keywordMatched: score.size, screenSize: screenIds.length, excluded: pool.excluded,
  })

  // 手動で選んだ求人（jobKeys）が精査の上限以内なら、一次審査を飛ばして全件を精査する（担当者が選んだ求人なので落とさない）
  const directDeep = !!criteria.jobKeys?.length && pool.ids.length <= cfg.deepMax
  // 段階3
  const screenJobsList = []
  let screen = new Map()
  if (directDeep) for (const id of screenIds) screen.set(id, 100)
  for (let i = 0; !directDeep && i < screenIds.length; i += 2000) {
    if (ctx.isCancelled?.()) break
    const part = loadJobs(db, screenIds.slice(i, i + 2000), { full: false })
    const s = await screenJobs(env, ctx, part, (d) => progress('screen', `一次審査中… ${(i + d).toLocaleString()} / ${screenIds.length.toLocaleString()}件`, { screened: i + d }))
    for (const [k, v] of s) screen.set(k, v)
    screenJobsList.length = 0
  }
  const passed = [...screen.values()].filter((v) => v >= cfg.deepMinScreen).length
  progress('screen', `一次審査が終わりました（有望 ${passed.toLocaleString()}件）`, { screened: screen.size, passed })

  // 段階4: 精査（判定）。いっぺんに全部ではなく、有望な順に少しずつ進め、
  //   「十分に良い求人」が提案件数より少し多く集まったら打ち切る（費用の大半はここ）
  const deepN = directDeep ? screenIds.length : Math.min(cfg.deepMax, Math.ceil(topN * cfg.deepMaxFactor))
  const order = directDeep ? screenIds : pickForDeep([...screen.keys()], screen, score, ctx.plan.angles, deepN, cfg.deepMinScreen)
  const target = topN + Math.ceil(topN * 0.25)
  const firstN = directDeep ? order.length : Math.min(order.length, Math.max(cfg.deepBatch * 4, Math.ceil(topN * cfg.deepFirst)))
  progress('deep', `有望な求人の求人票を全文で精査しています（最大 ${order.length}件。十分な候補が集まり次第終了）…`, { deepSize: order.length })
  const judged = []
  let stopReason = null
  for (let pos = 0; pos < order.length;) {
    if (ctx.isCancelled?.()) { stopReason = 'cancelled'; break }
    const size = pos === 0 ? firstN : Math.max(cfg.deepBatch * 2, Math.ceil(topN / 2))
    const wave = loadJobs(db, order.slice(pos, pos + size), { full: true })
    pos += size
    const r = await deepJudge(env, ctx, wave, () => {})
    judged.push(...r)
    const good = new Set(judged.filter((x) => x.eligibility !== 'unmet' && x.score >= cfg.goodScore).map((x) => dupKey(x.job) || x.job.id)).size
    progress('deep', `精査中… ${judged.length} / ${order.length}件（十分に良い候補 ${good}件）`, { judged: judged.length, good })
    if (!directDeep && good >= target) { stopReason = 'enough'; break }
    const usd = ctx.usage.usd
    if (cfg.maxUsd != null && usd != null && usd >= cfg.maxUsd * 0.85) { stopReason = 'budget'; break }
  }
  if (stopReason === 'enough') progress('deep', `十分な候補が集まったため精査を終了しました（${judged.length}件を精査）`)
  if (stopReason === 'budget') progress('deep', `費用の上限（$${cfg.maxUsd}）に近づいたため精査を終了しました（${judged.length}件を精査）`)

  // 仕上げ: 点数順。必須要件を満たさない求人は「参考」に回す
  for (const r of judged) {
    const s = score.get(r.job.id)
    r.screenScore = screen.get(r.job.id) ?? null
    if (!r.angle && s) { const ai = s.byAngle.indexOf(Math.max(...s.byAngle)); r.angle = ctx.plan.angles[ai]?.type || null }
    if (s) { const ai = s.byAngle.indexOf(Math.max(...s.byAngle)); r.angleLabel = s.byAngle[ai] > 0 ? ctx.plan.angles[ai]?.label : null }
  }
  judged.sort((a, b) => b.score - a.score || (b.rawScore - a.rawScore))
  // 同じ求人（媒体違いなど）は1件にまとめ、ほかは duplicates に入れる
  const groups = new Map()
  const uniq = []
  for (const r of judged) {
    const k = dupKey(r.job)
    if (k && groups.has(k)) { groups.get(k).duplicates.push({ key: `${r.job.source}:${r.job.source_job_id}`, id: r.job.id, score: r.score, reward: r.job.reward_text || null }); continue }
    r.duplicates = []
    if (k) groups.set(k, r)
    uniq.push(r)
  }
  const ok = uniq.filter((r) => r.score >= cfg.minScore && r.eligibility !== 'unmet')
  // 提案の幅: 上位が同じ種類だけで埋まらないよう、王道以外（発展・意外）で75点以上のものに最大2割の枠を確保
  const recommended = ok.slice(0, topN)
  const others = ok.slice(topN).filter((r) => r.angle && r.angle !== '王道' && r.score >= 75)
  const want = Math.min(others.length, Math.max(0, Math.floor(topN * 0.2) - recommended.filter((r) => r.angle && r.angle !== '王道').length))
  for (let k = 0; k < want; k++) recommended.splice(recommended.length - 1 - k, 1, others[k])
  recommended.sort((a, b) => b.score - a.score)
  const reference = uniq.filter((r) => r.eligibility === 'unmet' && r.rawScore >= 75).slice(0, 10)
  for (const r of [...uniq]) if (!recommended.includes(r)) r.reason = r.reason || r.fit
  progress('write', `提案する ${recommended.length}件の推薦文を書いています…`)
  await writeReasons(env, ctx, recommended)

  const summary = {
    elapsedSec: Math.round((Date.now() - t0) / 1000), poolSize: pool.ids.length, screened: screen.size, judged: judged.length,
    recommended: recommended.length, usage: ctx.usage.summary(), depth, precision, costMode: cfg.costMode, stopReason, cancelled: !!ctx.isCancelled?.(),
  }
  progress('done', `完了: ${recommended.length}件を提案`, summary)
  // 振り返り用: 一次審査の点数（職種別の分布を見て、取りこぼしを確認できるように）
  const screenLog = options.keepScreen ? [...screen.entries()].map(([id, s]) => ({ id, s, kw: Math.round((score.get(id)?.total || 0) * 100) / 100 })) : undefined
  return { plan: ctx.plan, pool: { size: pool.ids.length, query: pool.query, excluded: pool.excluded }, recommended, reference, judged, summary, screenLog }
}
