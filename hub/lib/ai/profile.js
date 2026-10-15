// ============================================================
// 求職者の書類（履歴書・職務経歴書など複数）を読み取り、経歴をまとめる
//
//   1) PDF → 文字を取り出す（pdf-parse。worker/node_modules のものを使う）
//   2) 氏名・住所・連絡先などの個人情報を伏せる（AIに送る前）
//   3) 全書類をまとめて、優秀なモデルで「経歴の事実」を細かく構造化する
//      ・職歴ごとの期間・職種・業界・役割・規模・実績
//      ・職種別の経験年数（「〇〇経験N年以上」の照合に使う）
//      ・資格・免許・語学・学歴・マネジメント経験
//      ・強み、目指せる方向性（隣接職種・キャリアアップ先）
//   PDFそのものは保存しない（呼び出し側で破棄する）
// ============================================================
import { workerRequire } from '../env.js'
import { chatJson, sanitize } from './llm.js'

let pdfParse = null
function loadPdfParse() {
  if (!pdfParse) pdfParse = workerRequire('pdf-parse/lib/pdf-parse.js')
  return pdfParse
}

const PREF = '(?:北海道|青森県|岩手県|宮城県|秋田県|山形県|福島県|茨城県|栃木県|群馬県|埼玉県|千葉県|東京都|神奈川県|新潟県|富山県|石川県|福井県|山梨県|長野県|岐阜県|静岡県|愛知県|三重県|滋賀県|京都府|大阪府|兵庫県|奈良県|和歌山県|鳥取県|島根県|岡山県|広島県|山口県|徳島県|香川県|愛媛県|高知県|福岡県|佐賀県|長崎県|熊本県|大分県|宮崎県|鹿児島県|沖縄県)'

// 個人情報を伏せる。経歴・スキルの情報は残す。
//   names: 求職者の登録名（姓・名・フルネームを本文から消す）
export function maskPII(text, { names = [] } = {}) {
  let t = String(text || '')
  t = t.replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, '［メール］')
  t = t.replace(/(?:\+?81[-\s]?)?0\d{1,3}[-(\)\s]\d{1,4}[-(\)\s]\d{3,4}/g, '［電話番号］')
  t = t.replace(/\b0[789]0\d{8}\b/g, '［電話番号］')
  t = t.replace(/〒\s?\d{3}[-−]?\d{4}/g, '［郵便番号］')
  t = t.replace(/(生年月日|誕生日)\s*[:：]?\s*[^\n]{0,30}/g, '$1: ［生年月日］')
  t = t.replace(/(?:19|20)\d{2}\s?年\s?\d{1,2}\s?月\s?\d{1,2}\s?日\s*生/g, '［生年月日］')
  t = t.replace(/(?:昭和|平成)\s?\d{1,2}\s?年\s?\d{1,2}\s?月\s?\d{1,2}\s?日\s*生/g, '［生年月日］')
  t = t.replace(new RegExp('(現住所|住所|所在地|連絡先)\\s*[:：]?\\s*' + PREF + '[^\\n]{0,50}', 'g'), '$1: ［住所］')
  t = t.replace(new RegExp(PREF + '[^\\n]{0,15}?(?:市|区|郡|町|村)[^\\n]{0,25}?\\d[-−丁目番地号\\d\\s]*', 'g'), '［住所］')
  t = t.replace(/(Address)\s*[:：]\s*[^\n]{1,60}/gi, '$1: ［住所］')
  t = t.replace(/(氏\s?名|名\s?前|フリガナ|ふりがな|カナ氏名|Name)\s*[:：]?\s*[^\n]{1,20}/gi, '$1: ［氏名］')
  for (const n of names) {
    for (const part of String(n || '').split(/[\s　]+/).concat([String(n || '').replace(/[\s　]+/g, '')])) {
      if (part && part.length >= 2) t = t.split(part).join('［氏名］')
    }
  }
  return t
}

// PDF(base64) → 文字
export async function pdfToText(base64) {
  const b64 = String(base64 || '').includes(',') ? base64.slice(base64.indexOf(',') + 1) : base64
  const buf = Buffer.from(b64 || '', 'base64')
  if (buf.subarray(0, 4).toString('latin1') !== '%PDF') throw new Error('PDFファイルではありません')
  const parsed = await loadPdfParse()(buf)
  const text = sanitize(parsed.text || '').replace(/[ \t\u3000]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim()
  if (text.replace(/\s/g, '').length < 30) {
    throw new Error('文字を読み取れませんでした（画像として保存されたPDFの可能性があります。文字を選択できるPDFでお試しください）')
  }
  return { text, pages: parsed.numpages || null }
}

const PROFILE_SYSTEM = `あなたは人材紹介会社の熟練キャリアアドバイザーです。
求職者の書類（履歴書・職務経歴書など。個人情報は伏せ字済み）をすべて読み、求人とのマッチングに使う「経歴の事実」を漏れなく正確に構造化してください。
後工程のAIは、ここで作った情報だけを見て「求人の必須要件を満たすか」を判定します。曖昧に要約せず、判定に使える具体的な事実（期間・人数・金額・ツール名・資格名）を残してください。

【厳守】
- 書類に書かれていない事実を作らない。推測した内容は inferred 系の項目にだけ書く。
- 期間は年月から計算する。「現在」「在職中」は今日（{TODAY}）まで在籍とみなす。
- 職種別の経験年数（jobTypeYears）は、複数社の同じ職種を合算する。キーは求人票と照合しやすい一般的な職種名（例: 法人営業, 経理, 人事, Webエンジニア, 施工管理）。
- 資格・免許は正式名称で。取得年月が分かれば付ける。「普通自動車運転免許」も重要。
- 書類同士で矛盾があれば notes に書く。

必ず次のJSONだけを返す:
{
  "summary": "経歴の要約（300字程度。何をどの規模でどれくらいやってきた人か）",
  "currentStatus": "在職中 / 離職中 / 不明",
  "education": { "level": "高卒|専門卒|短大卒|大卒|大学院卒|不明", "detail": "学校の種類・学部・専攻（校名は不要）", "graduationYear": 数値またはnull },
  "careers": [
    { "period": "2018/04〜現在", "years": 数値, "current": true/false,
      "companyType": "業界・規模（例: 東証プライム上場の人材サービス、従業員300名）", "employment": "正社員など",
      "jobType": "職種", "role": "役職・立場", "teamSize": "部下/チームの人数（あれば）",
      "duties": ["担当業務を具体的に"], "achievements": ["数値のある実績を具体的に"] }
  ],
  "jobTypeYears": { "職種": 年数 },
  "industryYears": { "業界": 年数 },
  "totalYears": 数値またはnull,
  "companyCount": 数値またはnull,
  "management": { "has": true/false, "maxReports": 数値またはnull, "years": 数値またはnull, "detail": "" },
  "skills": ["スキル・得意分野（例: 新規開拓, 提案営業, 予算管理）"],
  "tools": ["使えるツール・言語・システム（例: Salesforce, Excel(VLOOKUP/ピボット), Java, freee）"],
  "licenses": [ { "name": "資格・免許の正式名称", "acquired": "取得年月または不明" } ],
  "languages": [ { "language": "英語", "level": "TOEIC 800 / ビジネス会話 など" } ],
  "salary": { "current": "現年収（書類にあれば）", "desired": "希望年収（書類にあれば）" },
  "desires": ["書類に書かれた希望・志向（勤務地・働き方・やりたいこと）"],
  "strengths": ["強み（事実に基づく）"],
  "concerns": ["転職回数の多さ・空白期間・経験の浅さなど、求人によっては不利になりうる点"],
  "inferredDirections": [
    { "direction": "この経歴で狙える方向性（例: 法人営業→カスタマーサクセス、経理→経営企画アシスタント）", "why": "根拠" }
  ],
  "keywords": ["求人検索に使える語（職種名・業界名・スキル名・資格名）を10〜30語"],
  "notes": "書類の矛盾・読み取れなかった点など"
}`

// 複数の書類（個人情報は伏せ済み）→ 経歴の構造化
export async function buildProfile(env, docs, { memo = '', models, usage, today = new Date() } = {}) {
  const KIND = { resume: '履歴書', cv: '職務経歴書', other: 'その他の書類' }
  const per = Math.max(6000, Math.floor(60000 / Math.max(1, docs.length)))
  const body = docs.map((d, i) => `===== 書類${i + 1}（${KIND[d.kind] || d.kind}${d.filename ? `：${String(d.filename).replace(/[^\w.\-ぁ-んァ-ヶ一-龠ー]/g, '')}` : ''}）=====\n${String(d.masked_text || '').slice(0, per)}`).join('\n\n')
  const user = `${memo ? `【担当者のメモ（書類以外の情報）】\n${memo}\n\n` : ''}${body}`
  const sys = PROFILE_SYSTEM.replace('{TODAY}', today.toISOString().slice(0, 10))
  const { data, model } = await chatJson(env, { models, system: sys, user, effort: 'medium', maxTokens: 12000, usage, label: '書類の読み取り' })
  return { profile: data, model }
}

// 経歴（構造化）→ AIに渡す文章
export function profileToText(p) {
  if (!p || typeof p !== 'object') return ''
  const L = []
  const list = (a) => (Array.isArray(a) ? a.filter(Boolean) : [])
  if (p.summary) L.push(`【経歴の要約】${p.summary}`)
  if (p.currentStatus) L.push(`【現在】${p.currentStatus}`)
  if (p.education) L.push(`【最終学歴】${[p.education.level, p.education.detail, p.education.graduationYear ? `${p.education.graduationYear}年卒` : ''].filter(Boolean).join(' / ')}`)
  const jty = Object.entries(p.jobTypeYears || {}).filter(([, y]) => y != null)
  if (jty.length) L.push(`【職種別の経験年数】${jty.map(([k, y]) => `${k} 約${y}年`).join('、')}`)
  const iy = Object.entries(p.industryYears || {}).filter(([, y]) => y != null)
  if (iy.length) L.push(`【業界別の経験年数】${iy.map(([k, y]) => `${k} 約${y}年`).join('、')}`)
  if (p.totalYears != null) L.push(`【社会人経験】約${p.totalYears}年${p.companyCount != null ? ` / 経験社数 ${p.companyCount}社` : ''}`)
  if (p.management?.has) L.push(`【マネジメント】あり${p.management.maxReports ? `（最大${p.management.maxReports}名）` : ''}${p.management.years ? ` 約${p.management.years}年` : ''} ${p.management.detail || ''}`)
  else if (p.management) L.push('【マネジメント】経験の記載なし')
  for (const c of list(p.careers)) {
    L.push(`・${c.period || ''}（約${c.years ?? '?'}年${c.current ? '・在職中' : ''}）${c.companyType || ''} / ${c.employment || ''} / ${c.jobType || ''}${c.role ? ` / ${c.role}` : ''}${c.teamSize ? ` / ${c.teamSize}` : ''}`)
    if (list(c.duties).length) L.push(`   業務: ${list(c.duties).join('、')}`)
    if (list(c.achievements).length) L.push(`   実績: ${list(c.achievements).join('、')}`)
  }
  if (list(p.skills).length) L.push(`【スキル】${list(p.skills).join('、')}`)
  if (list(p.tools).length) L.push(`【ツール・技術】${list(p.tools).join('、')}`)
  L.push(`【資格・免許】${list(p.licenses).map((x) => `${x.name}${x.acquired && x.acquired !== '不明' ? `（${x.acquired}）` : ''}`).join('、') || '記載なし'}`)
  if (list(p.languages).length) L.push(`【語学】${list(p.languages).map((x) => `${x.language} ${x.level || ''}`).join('、')}`)
  if (p.salary?.current || p.salary?.desired) L.push(`【年収】現在 ${p.salary.current || '不明'} / 希望 ${p.salary.desired || '不明'}`)
  if (list(p.desires).length) L.push(`【書類に書かれた希望】${list(p.desires).join('、')}`)
  if (list(p.strengths).length) L.push(`【強み】${list(p.strengths).join('、')}`)
  if (list(p.concerns).length) L.push(`【不利になりうる点】${list(p.concerns).join('、')}`)
  if (list(p.inferredDirections).length) L.push(`【狙える方向性（推測）】${list(p.inferredDirections).map((d) => `${d.direction}（${d.why || ''}）`).join('、')}`)
  return L.join('\n')
}
