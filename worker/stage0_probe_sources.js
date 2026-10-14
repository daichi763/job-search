// ============================================================
// 段階0-3: 各媒体APIの差分同期可否の調査（読み取りのみ・VPSで実行）
//
//   媒体に対しては「検索・件数取得」しか行わない（応募・登録・変更などは一切しない）。
//   自社DB・webapp には一切書き込まない。結果はファイルに保存するだけ。
//
//   調べること（媒体ごと）:
//     1. 総件数
//     2. 生データの項目名と、日付系・勤務地系の項目のサンプル値
//     3. 並び順の切り替え可否（更新日時の新しい順にできるか）
//        → できれば「前回同期以降に更新された分だけ読む」差分同期が可能
//     4. 深いページの取得可否（例: 1万件目以降が取れるか）
//        → 取れない場合、現在の全件同期は構造的に取りこぼしている
//     5. 分類(都道府県)別の件数取得（削除検知の方式検証。circus/kintone）
//
//   使い方（VPS）:
//     cd /home/ubuntu/webapp/worker
//     node stage0_probe_sources.js                    # 全媒体
//     node stage0_probe_sources.js kintone jobins     # 媒体を指定
//     node stage0_probe_sources.js --force            # 検索中チェックを無視（非推奨）
//   出力: ~/stage0_probe_<日時>.json と標準出力のサマリ
//
//   ⚠ circus は同時ログイン1セッション制限があるため、実行中は常駐workerの
//     circusセッションが切れる可能性がある。AI検索・同期が動いていない時間帯に実行し、
//     終了後に `pm2 restart worker` で再ログインさせること（手順書参照）。
// ============================================================
import dotenv from 'dotenv'
dotenv.config({ override: true })
import fs from 'fs'
import os from 'os'
import path from 'path'
import { chromium } from 'playwright'
import { ADAPTERS } from './adapters.js'
import { PREFECTURES } from './circus_master.js'

const env = process.env
const APP_URL = env.APP_URL || 'http://localhost:3000'
const args = process.argv.slice(2)
const FORCE = args.includes('--force')
const targets = args.filter((a) => !a.startsWith('--'))
const SOURCES = targets.length ? targets : ['kintone', 'jobins', 'hitolink', 'circus']
const DELAY = parseInt(env.PROBE_DELAY_MS || '1200', 10) // 媒体への負荷を抑えるための間隔

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const log = (...a) => console.log(`[${new Date().toISOString().slice(11, 19)}]`, ...a)

// ---------- 共通ユーティリティ ----------
const DATE_KEY = /date|time|_at$|At$|日時|日$/i
const PREF_KEY = /pref|address|location|勤務地|town|city/i

function shapeOf(raw) {
  if (!raw || typeof raw !== 'object') return {}
  const keys = Object.keys(raw)
  const dates = {}
  const prefs = {}
  for (const k of keys) {
    let v = raw[k]
    // kintone は {type, value} 形式
    if (v && typeof v === 'object' && 'value' in v && 'type' in v) v = v.value
    if (DATE_KEY.test(k)) dates[k] = v
    if (PREF_KEY.test(k)) prefs[k] = JSON.stringify(v)?.slice(0, 200)
  }
  return { keyCount: keys.length, keys, dateFields: dates, prefectureFields: prefs }
}

function toTime(v) {
  if (v == null || v === '') return null
  if (typeof v === 'object' && v.raw) v = v.raw
  if (typeof v === 'object' && 'value' in v) v = v.value
  const t = Date.parse(String(v).replace(' ', 'T'))
  return Number.isFinite(t) ? t : null
}

// 並び順チェック: 指定項目が新しい順(降順)に並んでいるか
function orderCheck(jobs, getter) {
  const ts = jobs.map(getter).map(toTime)
  const valid = ts.filter((t) => t != null)
  let desc = 0, asc = 0
  for (let i = 1; i < ts.length; i++) {
    if (ts[i] == null || ts[i - 1] == null) continue
    if (ts[i] <= ts[i - 1]) desc++
    if (ts[i] >= ts[i - 1]) asc++
  }
  const pairs = Math.max(1, valid.length - 1)
  return {
    n: jobs.length,
    withDate: valid.length,
    isDesc: valid.length >= 3 && desc === pairs,
    descRatio: +(desc / pairs).toFixed(2),
    first: valid.length ? new Date(Math.max(...valid)).toISOString() : null,
    last: valid.length ? new Date(Math.min(...valid)).toISOString() : null,
  }
}

async function guardNotBusy() {
  if (FORCE) return
  try {
    const a = await (await fetch(`${APP_URL}/api/search/active`)).json()
    if (a && a.active) throw new Error(`AI検索が実行中です(searchJobId=${a.searchJobId})。終わってから再実行してください`)
    const t = await (await fetch(`${APP_URL}/api/trace/status`)).json()
    if (t && t.job && t.job.status === 'running') throw new Error(`全件同期が実行中です(traceJobId=${t.job.id})。終わってから再実行してください`)
  } catch (e) {
    if (/実行中/.test(e.message)) throw e
    log(`⚠ webapp の状態確認に失敗（${e.message}）。続行します`)
  }
}

async function newContextForSource(browser, source) {
  const opts = { viewport: { width: 1400, height: 1000 } }
  if (source === 'jobins') {
    opts.userAgent = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
    opts.locale = 'ja-JP'
    opts.viewport = { width: 1366, height: 768 }
    opts.extraHTTPHeaders = { 'Accept-Language': 'ja-JP,ja;q=0.9,en;q=0.8' }
  }
  const ctx = await browser.newContext(opts)
  if (source === 'jobins') {
    await ctx.addInitScript(() => { Object.defineProperty(navigator, 'webdriver', { get: () => undefined }) })
  }
  return ctx
}

// ============================================================
// kintone（REST API）
// ============================================================
async function probeKintone() {
  const a = ADAPTERS.kintone
  const r = { source: 'kintone' }
  const call = (query, opt = {}) => a._apiCall(query, opt)

  r.totalAll = parseInt((await call('', { totalCount: true, fields: ['$id'], limit: 1 })).totalCount, 10)
  r.totalOpen = parseInt((await call('求人公開 in ("可能")', { totalCount: true, fields: ['$id'], limit: 1 })).totalCount, 10)

  const page1 = await call('求人公開 in ("可能") order by 更新日時 desc', { limit: 20 })
  r.sample = shapeOf(page1.records?.[0])
  r.orderByUpdated = orderCheck(page1.records || [], (x) => x['更新日時'])

  // 差分条件: 直近1日/7日に更新されたレコード数（＝日次差分で読む量の目安）
  for (const d of [1, 7]) {
    const since = new Date(Date.now() - d * 86400000).toISOString().replace(/\.\d+Z$/, 'Z')
    const j = await call(`更新日時 > "${since}"`, { totalCount: true, fields: ['$id'], limit: 1 })
    r[`updatedLast${d}d`] = parseInt(j.totalCount, 10)
  }
  // 全IDの取得コスト（削除検知を全ID照合で行えるか）
  const t = Date.now()
  let ids = 0
  for (let off = 0; off < r.totalAll; off += 500) {
    const j = await call('order by $id asc', { fields: ['$id'], limit: 500, offset: off })
    ids += (j.records || []).length
    if (!(j.records || []).length) break
  }
  r.allIdsFetch = { ids, ms: Date.now() - t }
  r.verdict = {
    差分取得: '◎ 更新日時 > "前回時刻" で可能',
    削除検知: `◎ 全ID取得が ${r.allIdsFetch.ms}ms で可能 → 毎日全ID照合でよい`,
  }
  return r
}

// ============================================================
// circus（内部REST: ブラウザ内fetch）
// ============================================================
async function probeCircus(page) {
  const a = ADAPTERS.circus
  const r = { source: 'circus' }
  await a.login(page, env)
  const token = await a.getAuthToken(page)
  const qJson = a.buildQJson({})

  // orderBy を差し替えられる版の呼び出し
  const call = (endpoint, { orderBy = 'recommendScore', order = 'desc', limit = 25, offset = 0, pairs = [] } = {}) =>
    page.evaluate(async ({ token, endpoint, qJson, orderBy, order, limit, offset, pairs }) => {
      const qs = new URLSearchParams()
      for (const q of qJson) qs.append('qJson', JSON.stringify(q))
      qs.set('limit', String(limit)); qs.set('offset', String(offset))
      qs.set('page', String(Math.floor(offset / limit) + 1))
      if (orderBy) qs.set('orderBy', orderBy)
      if (order) qs.set('order', order)
      for (const [k, v] of pairs) qs.append(k, v)
      const res = await fetch(`https://circus-job.com/api/${endpoint}?` + qs.toString(), {
        credentials: 'include',
        headers: { accept: 'application/json, text/plain, */*', 'x-circus-authentication-token': token },
      })
      let json = null
      try { json = await res.json() } catch {}
      return { status: res.status, json }
    }, { token, endpoint, qJson, orderBy, order, limit, offset, pairs })

  const base = await call('jobSearch', {})
  r.total = base.json?.total ?? null
  const jobs0 = base.json?.jobs || []
  r.sample = shapeOf(jobs0[0])
  r.defaultOrder = { lastUpdatedAt: orderCheck(jobs0, (x) => x.lastUpdatedAt), openFalse: jobs0.filter((x) => x.open === false).length }
  await sleep(DELAY)

  // 並び順の候補（画面の「新着順」等が内部でどの値か不明なため総当たり）
  r.orderBy = {}
  for (const ob of ['lastUpdatedAt', 'updatedAt', 'publishStartedAt', 'newArrival', 'new', 'createdAt', 'publishedAt']) {
    const x = await call('jobSearch', { orderBy: ob, order: 'desc' })
    const js = x.json?.jobs || []
    r.orderBy[ob] = {
      status: x.status, n: js.length,
      sameAsDefault: js.length && jobs0.length ? js[0]?.id === jobs0[0]?.id && js[1]?.id === jobs0[1]?.id : null,
      lastUpdatedAt: orderCheck(js, (j) => j.lastUpdatedAt),
      publishStartedAt: orderCheck(js, (j) => j.publishStartedAt),
    }
    log(`[circus] orderBy=${ob} status=${x.status} desc(更新)=${r.orderBy[ob].lastUpdatedAt.isDesc} desc(掲載)=${r.orderBy[ob].publishStartedAt.isDesc}`)
    await sleep(DELAY)
  }

  // 深いページ
  r.deepPaging = {}
  if (r.total) {
    for (const off of [9975, 10000, 50000, Math.max(0, r.total - 25)]) {
      if (off >= r.total) continue
      const x = await call('jobSearch', { offset: off })
      r.deepPaging[off] = { status: x.status, n: (x.json?.jobs || []).length }
      log(`[circus] offset=${off} status=${x.status} n=${r.deepPaging[off].n}`)
      await sleep(DELAY)
    }
  }

  // 都道府県別件数（削除検知の分類単位に使えるか: 合計 ≒ 総数 か）
  const prefCodes = Object.keys(PREFECTURES)
  let sum = 0, ok = 0
  const byPref = {}
  const t = Date.now()
  for (const code of prefCodes) {
    const x = await call('jobSearchMatches', { limit: 1, pairs: [['prefectures', code]] })
    const n = x.json?.matches ?? x.json?.total ?? x.json?.count ?? null
    if (typeof n === 'number') { sum += n; ok++ }
    const e = PREFECTURES[code]
    byPref[(e && (e.label || e)) || code] = n
    await sleep(300)
  }
  r.prefectureCounts = { ok, of: prefCodes.length, sum, total: r.total, ms: Date.now() - t, byPref }
  log(`[circus] 都道府県別件数 合計=${sum} / 総数=${r.total}（複数県の求人は重複計上されるため合計>総数は正常）`)
  return r
}

// ============================================================
// hitolink（Next.js Server Action）
// ============================================================
async function probeHitolink(page) {
  const a = ADAPTERS.hitolink
  const r = { source: 'hitolink' }
  await a.login(page, env)
  const token = await a.getAuthToken(page)
  const body = a.buildQJson({}, {})

  const call = async ({ sortType = 0, pageNo = 1, pageSize = 50 } = {}) => {
    const x = await a._actionCall(page, token, [
      `/matter/query/search-matter?pageNo=${pageNo}&pageSize=${pageSize}&sortType=${sortType}`,
      { method: 'POST', body: JSON.stringify(body) },
    ])
    const obj = x.status === 200 ? a._parseFlight(x.text) : null
    return { status: x.status, ok: !!(obj && obj.ok), total: obj?.data?.totalCount ?? null, jobs: obj?.data?.matters || [] }
  }

  const base = await call({})
  r.total = base.total
  r.sample = shapeOf(base.jobs[0])
  r.sortType = {}
  for (const st of [0, 1, 2, 3, 4, 5, 6, 7, 8]) {
    const x = await call({ sortType: st })
    r.sortType[st] = {
      status: x.status, ok: x.ok, n: x.jobs.length, total: x.total,
      updateDateTime: orderCheck(x.jobs, (j) => j.updateDateTime),
      insertDateTime: orderCheck(x.jobs, (j) => j.insertDateTime),
    }
    log(`[hitolink] sortType=${st} ok=${x.ok} desc(更新)=${r.sortType[st].updateDateTime.isDesc} desc(登録)=${r.sortType[st].insertDateTime.isDesc}`)
    await sleep(DELAY)
  }
  r.deepPaging = {}
  if (r.total) {
    for (const p of [100, 200, 1000, Math.ceil(r.total / 100)]) {
      const x = await call({ pageNo: p, pageSize: 100 })
      r.deepPaging[`page${p}(×100)`] = { status: x.status, ok: x.ok, n: x.jobs.length }
      log(`[hitolink] pageNo=${p} ok=${x.ok} n=${x.jobs.length}`)
      await sleep(DELAY)
    }
  }
  return r
}

// ============================================================
// jobins（REST）
// ============================================================
async function probeJobins(page) {
  const a = ADAPTERS.jobins
  const r = { source: 'jobins' }
  await a.login(page, env)
  const token = await a.getAuthToken(page)

  const call = async ({ sort, pageNo = 1, perPage = 50 } = {}) => {
    const body = a.buildQJson({}, {})
    if (sort !== undefined) body.sort = sort
    body.page = pageNo
    body.per_page = perPage
    const x = await a._apiCall(page, token, body)
    return {
      status: x.status, ok: !!(x.json && x.json.success),
      total: x.json?.meta?.pagination?.total ?? null,
      lastPage: x.json?.meta?.pagination?.total_pages ?? x.json?.meta?.pagination?.last_page ?? null,
      jobs: Array.isArray(x.json?.data) ? x.json.data : [],
    }
  }

  const base = await call({})
  r.total = base.total
  r.lastPage = base.lastPage
  r.sample = shapeOf(base.jobs[0])
  r.sort = {}
  for (const s of ['job_score:desc', 'updated_at:desc', 'created_at:desc', 'open_date:desc', 'published_at:desc', 'id:desc']) {
    const x = await call({ sort: s })
    r.sort[s] = {
      status: x.status, ok: x.ok, n: x.jobs.length,
      updated_at: orderCheck(x.jobs, (j) => j.updated_at),
      created_at: orderCheck(x.jobs, (j) => j.created_at),
    }
    log(`[jobins] sort=${s} ok=${x.ok} desc(更新)=${r.sort[s].updated_at.isDesc} desc(作成)=${r.sort[s].created_at.isDesc}`)
    await sleep(DELAY)
  }
  r.deepPaging = {}
  if (r.total) {
    for (const p of [100, 101, 200, 1000, Math.ceil(r.total / 100)]) {
      const x = await call({ pageNo: p, perPage: 100 })
      r.deepPaging[`page${p}(×100)`] = { status: x.status, ok: x.ok, n: x.jobs.length }
      log(`[jobins] page=${p} ok=${x.ok} n=${x.jobs.length}`)
      await sleep(DELAY)
    }
  }
  return r
}

// ============================================================
async function main() {
  await guardNotBusy()
  const out = { startedAt: new Date().toISOString(), host: os.hostname(), results: {} }
  const needBrowser = SOURCES.some((s) => s !== 'kintone')
  const browser = needBrowser ? await chromium.launch({ headless: true }) : null
  try {
    for (const s of SOURCES) {
      log(`===== ${s} 調査開始 =====`)
      const t = Date.now()
      let ctx = null
      try {
        if (s === 'kintone') {
          out.results[s] = await probeKintone()
        } else {
          ctx = await newContextForSource(browser, s)
          const page = await ctx.newPage()
          const fn = { circus: probeCircus, hitolink: probeHitolink, jobins: probeJobins }[s]
          if (!fn) throw new Error('未対応の媒体')
          out.results[s] = await fn(page)
        }
      } catch (e) {
        out.results[s] = { source: s, error: e.message }
        log(`❌ ${s}: ${e.message}`)
      } finally {
        if (ctx) await ctx.close().catch(() => {})
      }
      if (out.results[s]) out.results[s].elapsedMs = Date.now() - t
      log(`===== ${s} 完了 (${((Date.now() - t) / 1000).toFixed(0)}秒) =====`)
    }
  } finally {
    if (browser) await browser.close().catch(() => {})
  }
  out.finishedAt = new Date().toISOString()
  const file = path.join(os.homedir(), `stage0_probe_${out.startedAt.replace(/[:.]/g, '-').slice(0, 19)}.json`)
  fs.writeFileSync(file, JSON.stringify(out, null, 2))

  // サマリ
  console.log('\n================ サマリ ================')
  for (const [s, r] of Object.entries(out.results)) {
    if (r.error) { console.log(`${s}: ❌ ${r.error}`); continue }
    const total = r.total ?? r.totalOpen
    const descOpts = []
    for (const [k, v] of Object.entries(r.orderBy || r.sortType || r.sort || {})) {
      const anyDesc = Object.values(v).some((x) => x && x.isDesc)
      if (anyDesc) descOpts.push(k)
    }
    const deep = Object.entries(r.deepPaging || {}).map(([k, v]) => `${k}:${v.n}件`).join(' ')
    console.log(`${s}: 総数=${total}  日付降順にできた並び順=[${descOpts.join(', ') || (r.orderByUpdated?.isDesc ? 'order by 更新日時' : 'なし')}]  深いページ=${deep || '-'}`)
  }
  console.log(`\n詳細: ${file}`)
  console.log('（媒体への書き込み・自社DBへの書き込みは行っていません）')
}

main().catch((e) => { console.error('fatal:', e.message); process.exit(1) })
