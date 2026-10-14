// ============================================================
// 段階0-4: 追加調査（読み取りのみ・VPSで実行）
//   1回目の調査結果を受けて、全件取得の所要時間を見積もるための追加調査。
//
//   調べること:
//     1. 1回で取れる最大件数（circus limit / hitolink pageSize / jobins per_page）と1回あたりの時間
//        → 全件取得にかかる時間の見積もり
//     2. jobins の日付項目の実際の形式と、並び順(sort)が効いているか
//     3. circus の lastUpdatedAt 降順で「直近1日・7日に更新された件数」
//        hitolink の updateDateTime 降順で同様
//        → 毎日の差分で読む量の見積もり
//
//   使い方（VPS・AI検索を使っていない時間帯に）:
//     cd /home/ubuntu/webapp/worker
//     pm2 stop worker
//     node stage0_probe2.js | tee ~/stage0_probe2_log.txt
//     pm2 start worker
// ============================================================
import dotenv from 'dotenv'
dotenv.config({ override: true })
import fs from 'fs'
import os from 'os'
import path from 'path'
import { chromium } from 'playwright'
import { ADAPTERS } from './adapters.js'

const env = process.env
const args = process.argv.slice(2).filter((a) => !a.startsWith('--'))
const SOURCES = args.length ? args : ['jobins', 'hitolink', 'circus']
const DELAY = parseInt(env.PROBE_DELAY_MS || '1500', 10)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const log = (...a) => console.log(`[${new Date().toISOString().slice(11, 19)}]`, ...a)

function toTime(v) {
  if (v == null || v === '') return null
  if (typeof v === 'object' && v.raw != null) v = v.raw
  if (typeof v === 'object' && v.value != null) v = v.value
  if (typeof v === 'number') return v > 1e12 ? v : v * 1000
  const t = Date.parse(String(v).replace(' ', 'T'))
  return Number.isFinite(t) ? t : null
}
const isDesc = (arr) => { const t = arr.map(toTime).filter((x) => x != null); return t.length >= 3 && t.every((x, i) => i === 0 || x <= t[i - 1]) }
// 降順リストのうち、since より新しいものが何件目まで続くか
const countSince = (arr, since) => arr.map(toTime).filter((t) => t != null && t >= since).length

async function newContext(browser, source) {
  const opts = { viewport: { width: 1400, height: 1000 } }
  if (source === 'jobins') {
    opts.userAgent = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
    opts.locale = 'ja-JP'; opts.viewport = { width: 1366, height: 768 }
    opts.extraHTTPHeaders = { 'Accept-Language': 'ja-JP,ja;q=0.9,en;q=0.8' }
  }
  const ctx = await browser.newContext(opts)
  if (source === 'jobins') await ctx.addInitScript(() => { Object.defineProperty(navigator, 'webdriver', { get: () => undefined }) })
  return ctx
}

// 1回で取れる件数と時間を計測する共通処理
async function measureSizes(name, sizes, fetchFn, total) {
  const out = {}
  for (const s of sizes) {
    const t = Date.now()
    let n = 0, err = null
    try { n = (await fetchFn(s)).length } catch (e) { err = e.message }
    const ms = Date.now() - t
    const calls = n ? Math.ceil(total / n) : null
    out[s] = { got: n, ms, err, estFullMinutes: calls ? Math.round((calls * (ms + DELAY)) / 60000) : null }
    log(`[${name}] size=${s} 取得=${n}件 ${ms}ms${err ? ' ERR ' + err : ''} → 全件の見積もり ${out[s].estFullMinutes ?? '-'}分`)
    await sleep(DELAY)
  }
  return out
}

// ---------------- jobins ----------------
async function probeJobins(page) {
  const a = ADAPTERS.jobins
  await a.login(page, env)
  const token = await a.getAuthToken(page)
  const call = async ({ sort, pageNo = 1, perPage = 20 } = {}) => {
    const body = a.buildQJson({}, {})
    if (sort !== undefined) body.sort = sort
    body.page = pageNo; body.per_page = perPage
    const x = await a._apiCall(page, token, body)
    if (x.status !== 200 || !x.json?.success) throw new Error(`status=${x.status}`)
    return { total: x.json.meta?.pagination?.total, pagination: x.json.meta?.pagination, jobs: x.json.data || [] }
  }
  const r = { source: 'jobins' }
  const base = await call({ perPage: 5 })
  r.total = base.total
  r.paginationKeys = base.pagination
  const j0 = base.jobs[0] || {}
  // 日付っぽい項目の生の値（形式確認）
  r.dateLike = {}
  for (const [k, v] of Object.entries(j0)) {
    if (/date|_at$|time|open|publish|period|deadline/i.test(k)) r.dateLike[k] = v
  }
  r.allKeys = Object.keys(j0)
  log(`[jobins] 日付系項目: ${JSON.stringify(r.dateLike).slice(0, 600)}`)

  // sort が効いているか: 先頭5件のIDが既定と変わるか
  r.sort = {}
  const ids0 = base.jobs.map((j) => j.id).join(',')
  for (const s of ['updated_at:desc', 'updated_at:asc', 'created_at:desc', 'id:desc', 'id:asc', 'open_date:desc', 'job_score:asc']) {
    try {
      const x = await call({ sort: s, perPage: 20 })
      const ids = x.jobs.slice(0, 5).map((j) => j.id).join(',')
      r.sort[s] = { changed: ids !== ids0, updatedDesc: isDesc(x.jobs.map((j) => j.updated_at)), createdDesc: isDesc(x.jobs.map((j) => j.created_at)), firstUpdated: x.jobs[0]?.updated_at }
    } catch (e) { r.sort[s] = { err: e.message } }
    log(`[jobins] sort=${s} ${JSON.stringify(r.sort[s]).slice(0, 200)}`)
    await sleep(DELAY)
  }
  r.pageSize = await measureSizes('jobins', [100, 200, 500], async (s) => (await call({ perPage: s })).jobs, r.total)
  return r
}

// ---------------- hitolink ----------------
async function probeHitolink(page) {
  const a = ADAPTERS.hitolink
  await a.login(page, env)
  const token = await a.getAuthToken(page)
  const body = a.buildQJson({}, {})
  const call = async ({ pageNo = 1, pageSize = 100 } = {}) => {
    const x = await a._actionCall(page, token, [
      `/matter/query/search-matter?pageNo=${pageNo}&pageSize=${pageSize}&sortType=0`,
      { method: 'POST', body: JSON.stringify(body) },
    ])
    const obj = x.status === 200 ? a._parseFlight(x.text) : null
    if (!obj || !obj.ok) throw new Error(`status=${x.status}`)
    return { total: obj.data.totalCount, jobs: obj.data.matters || [] }
  }
  const r = { source: 'hitolink' }
  const base = await call({ pageSize: 100 })
  r.total = base.total
  r.pageSize = await measureSizes('hitolink', [100, 200, 500, 1000], async (s) => (await call({ pageSize: s })).jobs, r.total)

  // 差分量: updateDateTime 降順で直近1日/7日に更新された件数
  const now = Date.now()
  let n1 = 0, n7 = 0, scanned = 0
  for (let p = 1; p <= 30; p++) {
    const x = await call({ pageNo: p, pageSize: 100 })
    scanned += x.jobs.length
    const u = x.jobs.map((j) => j.updateDateTime)
    n1 += countSince(u, now - 86400000); n7 += countSince(u, now - 7 * 86400000)
    const last = toTime(u[u.length - 1])
    if (!x.jobs.length || (last != null && last < now - 7 * 86400000)) break
    await sleep(DELAY)
  }
  r.recent = { updatedLast1d: n1, updatedLast7d: n7, scanned, note: '30ページ(3,000件)で打ち切り。7日分が3,000件を超える場合は下限値' }
  log(`[hitolink] 直近1日更新=${n1} 直近7日更新=${n7}（${scanned}件確認）`)
  return r
}

// ---------------- circus ----------------
async function probeCircus(page) {
  const a = ADAPTERS.circus
  await a.login(page, env)
  const token = await a.getAuthToken(page)
  const qJson = a.buildQJson({})
  const call = ({ limit = 25, offset = 0, orderBy = 'lastUpdatedAt' } = {}) =>
    page.evaluate(async ({ token, qJson, limit, offset, orderBy }) => {
      const qs = new URLSearchParams()
      for (const q of qJson) qs.append('qJson', JSON.stringify(q))
      qs.set('limit', String(limit)); qs.set('offset', String(offset))
      qs.set('page', String(Math.floor(offset / limit) + 1))
      qs.set('orderBy', orderBy); qs.set('order', 'desc')
      const res = await fetch('https://circus-job.com/api/jobSearch?' + qs.toString(), {
        credentials: 'include',
        headers: { accept: 'application/json, text/plain, */*', 'x-circus-authentication-token': token },
      })
      let json = null; try { json = await res.json() } catch {}
      if (res.status !== 200) throw new Error(`status=${res.status}`)
      return { total: json?.total, jobs: json?.jobs || [] }
    }, { token, qJson, limit, offset, orderBy })

  const r = { source: 'circus' }
  const base = await call({ limit: 25 })
  r.total = base.total
  r.pageSize = await measureSizes('circus', [25, 50, 100, 200], async (s) => (await call({ limit: s })).jobs, r.total)
  // 深いoffsetでの速度（1回目調査で深いページほど遅い傾向があったため）
  r.deepTiming = {}
  for (const off of [0, 20000, 80000, 150000]) {
    const t = Date.now()
    try { await call({ limit: 100, offset: off }) } catch (e) {}
    r.deepTiming[off] = Date.now() - t
    log(`[circus] offset=${off} limit=100 ${r.deepTiming[off]}ms`)
    await sleep(DELAY)
  }
  // 差分量: lastUpdatedAt 降順で直近1日/7日
  const now = Date.now()
  let n1 = 0, n7 = 0, scanned = 0
  for (let p = 0; p < 30; p++) {
    const x = await call({ limit: 100, offset: p * 100 })
    scanned += x.jobs.length
    const u = x.jobs.map((j) => j.lastUpdatedAt)
    n1 += countSince(u, now - 86400000); n7 += countSince(u, now - 7 * 86400000)
    const last = toTime(u[u.length - 1])
    if (!x.jobs.length || (last != null && last < now - 7 * 86400000)) break
    await sleep(DELAY)
  }
  r.recent = { updatedLast1d: n1, updatedLast7d: n7, scanned, note: '3,000件で打ち切り。超える場合は下限値' }
  r.sampleDates = { lastUpdatedAt: base.jobs[0]?.lastUpdatedAt, publishStartedAt: base.jobs[0]?.publishStartedAt, open: base.jobs[0]?.open }
  log(`[circus] 直近1日更新=${n1} 直近7日更新=${n7}（${scanned}件確認） sample=${JSON.stringify(r.sampleDates)}`)
  return r
}

async function main() {
  const out = { startedAt: new Date().toISOString(), results: {} }
  const browser = await chromium.launch({ headless: true })
  try {
    for (const s of SOURCES) {
      log(`===== ${s} 追加調査開始 =====`)
      const ctx = await newContext(browser, s)
      try {
        const page = await ctx.newPage()
        out.results[s] = await ({ jobins: probeJobins, hitolink: probeHitolink, circus: probeCircus }[s])(page)
      } catch (e) {
        out.results[s] = { error: e.message }
        log(`❌ ${s}: ${e.message}`)
      } finally { await ctx.close().catch(() => {}) }
    }
  } finally { await browser.close().catch(() => {}) }
  const file = path.join(os.homedir(), `stage0_probe2_${out.startedAt.replace(/[:.]/g, '-').slice(0, 19)}.json`)
  fs.writeFileSync(file, JSON.stringify(out, null, 2))
  console.log(`\n詳細: ${file}\n（媒体・自社DBへの書き込みは行っていません）`)
}
main().catch((e) => { console.error('fatal:', e.message); process.exit(1) })
