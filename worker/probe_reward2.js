// 成果報酬フィールドの構造を実データで徹底調査（VPSで実行）
//   使い方: cd worker && node probe_reward2.js
//
//   目的: circus の commissionFee が「率(%)」と「固定額(円)」を
//         どう区別しているかを実データで確定する。
//         fee:60 が「率60%」か「一律60万円」か値だけでは判別不能なため、
//         commissionFee 内の種別フィールド(type/unit/kind等)や
//         付随フィールドの有無・分布を洗い出す。
import dotenv from 'dotenv'
dotenv.config({ override: true })
import { chromium } from 'playwright'
import { ADAPTERS } from './adapters.js'

const env = process.env
const a = ADAPTERS.circus

const browser = await chromium.launch({ headless: (env.HEADLESS || 'true') === 'true' })
const ctx = await browser.newContext()
const page = await ctx.newPage()

try {
  await a.login(page, env)
  const token = await a.getAuthToken(page)
  const qJson = a.buildQJson({ or: '' })

  // 多めに取得してcommissionFeeの多様性を見る（最大12ページ=300件）
  const MAX_PAGES = 12
  const all = []
  for (let p = 0; p < MAX_PAGES; p++) {
    const resp = await a.apiSearch(page, token, {
      qJson, filters: {}, limit: 25, offset: p * 25, pageNo: p + 1,
    })
    const jobs = resp.jobs || []
    if (!jobs.length) break
    all.push(...jobs)
  }
  console.log(`取得 ${all.length} 件\n`)

  // 1) commissionFee のキー構造のバリエーションを集計
  const shapeCount = {}   // "id,fee" のようなキー並び → 件数
  const feeValues = {}    // fee値 → 件数
  const withExtra = []    // id/fee以外のキーを持つ稀なサンプル
  let nullCount = 0

  for (const j of all) {
    const cf = j.commissionFee
    if (cf == null) { nullCount++; continue }
    if (typeof cf !== 'object') {
      const key = `(primitive:${typeof cf})`
      shapeCount[key] = (shapeCount[key] || 0) + 1
      continue
    }
    const keys = Object.keys(cf).sort()
    const shape = keys.join(',')
    shapeCount[shape] = (shapeCount[shape] || 0) + 1
    // fee値の分布
    if (cf.fee != null) {
      const v = String(cf.fee)
      feeValues[v] = (feeValues[v] || 0) + 1
    }
    // id/fee 以外のキーがあれば貴重（種別フィールドの可能性）
    const extra = keys.filter((k) => k !== 'id' && k !== 'fee')
    if (extra.length && withExtra.length < 10) {
      withExtra.push({ id: j.id, commissionFee: cf })
    }
  }

  console.log('=== commissionFee のキー構造の分布 ===')
  console.log('  null:', nullCount, '件')
  for (const [shape, cnt] of Object.entries(shapeCount).sort((a, b) => b[1] - a[1])) {
    console.log(`  {${shape}} : ${cnt}件`)
  }

  console.log('\n=== fee 値の分布（率か固定額かの手がかり） ===')
  const sorted = Object.entries(feeValues).sort((a, b) => parseFloat(a[0]) - parseFloat(b[0]))
  for (const [v, cnt] of sorted) console.log(`  fee=${v} : ${cnt}件`)

  console.log('\n=== id/fee 以外のキーを持つサンプル（種別フィールド候補） ===')
  if (withExtra.length === 0) {
    console.log('  なし（commissionFee は常に {id, fee} 構造）')
  } else {
    for (const s of withExtra) console.log(' ', JSON.stringify(s))
  }

  // 2) commissionFee 以外に報酬額らしき数値フィールドがないかもう一度全キー走査
  console.log('\n=== トップレベルで金額/率らしきフィールド候補（全求人でnullでない値を持つもの） ===')
  const numericFieldSamples = {}
  const reKey = /(fee|reward|commission|amount|price|money|salary|incentive|bonus)/i
  for (const j of all) {
    for (const [k, v] of Object.entries(j)) {
      if (!reKey.test(k)) continue
      if (v == null) continue
      if (!numericFieldSamples[k]) numericFieldSamples[k] = new Set()
      if (numericFieldSamples[k].size < 6) {
        numericFieldSamples[k].add(typeof v === 'object' ? JSON.stringify(v) : String(v))
      }
    }
  }
  for (const [k, set] of Object.entries(numericFieldSamples)) {
    console.log(`  ${k}: 例 ${[...set].slice(0, 6).join(' | ')}`)
  }

  // 3) fee値が高い(例:60以上)の求人の年収と突き合わせ（率なら年収と無関係、固定なら…の判断材料）
  console.log('\n=== fee>=50 の求人サンプル（率か固定かの状況証拠。年収と併記） ===')
  let shown = 0
  for (const j of all) {
    const cf = j.commissionFee
    if (cf && typeof cf === 'object' && cf.fee != null && cf.fee >= 50 && shown < 8) {
      const sal = j.expectedAnnualSalary || {}
      console.log(`  id=${j.id} fee=${cf.fee} 年収=${sal.min}〜${sal.max}万 「${String(j.name || '').slice(0, 30)}」`)
      shown++
    }
  }
} catch (e) {
  console.error('probe error:', e)
} finally {
  await browser.close()
}
