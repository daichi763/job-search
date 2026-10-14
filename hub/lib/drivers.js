// ============================================================
// 媒体ごとの「全件を読む」処理
//
//   ログイン・API呼び出し・データ変換(mapApiJob)は既存の worker/adapters.js をそのまま使う。
//   （既存アプリと同じ実績のあるコード。ここでは「読み方」だけを定義する）
//
//   共通の約束:
//     run(ctx) → { remoteTotal, pagesOk, pagesFailed, complete, reason }
//     ctx = { cfg, env, browser, log, onPage(items), shouldStop() }
//       onPage(items): items = [{ mapped, raw }] を同期エンジンへ渡す
//       shouldStop(): 時間切れなら true
// ============================================================
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { WORKER_DIR } from './env.js'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let adaptersPromise = null
export function loadAdapters() {
  if (!adaptersPromise) adaptersPromise = import(pathToFileURL(path.join(WORKER_DIR, 'adapters.js')).href).then((m) => m.ADAPTERS)
  return adaptersPromise
}

// 1ページの取得を最大 n 回試す（失敗の合間に onRetry で再ログイン等）
async function withRetry(n, fn, { log, label, onRetry, delayMs = 1500 }) {
  let last
  for (let i = 1; i <= n; i++) {
    try {
      return await fn()
    } catch (e) {
      last = e
      log(`${label} 失敗 ${i}/${n}: ${e.message}`)
      if (i < n) {
        if (onRetry) { try { await onRetry(e, i) } catch (re) { log(`再試行の準備に失敗: ${re.message}`) } }
        await sleep(delayMs * i)
      }
    }
  }
  throw last
}

function judge({ remoteTotal, fetched, pagesFailed, stopped, cfg, extra }) {
  if (stopped) return { complete: false, reason: '時間切れ' }
  if (pagesFailed > 0) return { complete: false, reason: `${pagesFailed}ページ取得失敗` }
  if (extra) return { complete: false, reason: extra }
  if (remoteTotal != null && fetched < remoteTotal * cfg.completeRatio) {
    return { complete: false, reason: `取得${fetched}件が媒体総数${remoteTotal}件の${cfg.completeRatio * 100}%未満` }
  }
  return { complete: true, reason: null }
}

// ------------------------------------------------------------
// kintone（自社DB）: 公式REST API。$id の昇順カーソルで全件を確実に読む
// ------------------------------------------------------------
export const kintone = {
  source: 'kintone',
  needsBrowser: false,
  authoritative: true, // 1回で全件を確実に読めるので、1回の欠落で掲載終了にしてよい
  async run(ctx) {
    const a = (ctx.adapters || await loadAdapters()).kintone
    const { cfg, log, onPage, shouldStop, session } = ctx
    if (!a.apiToken) throw new Error('KINTONE_API_TOKEN が未設定です（worker/.env）')
    const OPEN = '求人公開 in ("可能")'
    const head = await a._apiCall(OPEN, { totalCount: true, fields: ['$id'], limit: 1 })
    const remoteTotal = parseInt(head.totalCount, 10)
    log(`媒体の総数 ${remoteTotal} 件`)
    let lastId = 0, pagesOk = 0, pagesFailed = 0, stopped = false
    while (true) {
      if (shouldStop()) { stopped = true; break }
      let json
      try {
        json = await withRetry(cfg.pageRetry, () => a._apiCall(`${OPEN} and $id > ${lastId} order by $id asc`, { limit: cfg.pageSize.kintone }),
          { log, label: `kintone $id>${lastId}` })
      } catch (e) { pagesFailed++; break } // カーソル方式なので失敗したら先へ進めない
      const recs = json.records || []
      if (!recs.length) break
      pagesOk++
      onPage(recs.map((raw) => ({ mapped: a.mapApiJob(raw), raw })))
      lastId = parseInt(recs[recs.length - 1].$id.value, 10)
      if (recs.length < cfg.pageSize.kintone) break
    }
    return { remoteTotal, pagesOk, pagesFailed, ...judge({ remoteTotal, fetched: session.stats.fetched, pagesFailed, stopped, cfg }) }
  },
}

// ------------------------------------------------------------
// ヒトリンク: ログイン → 内部API。1回 1,000件（調査で 1.6秒/回 を確認）
// ------------------------------------------------------------
export const hitolink = {
  source: 'hitolink',
  needsBrowser: true,
  authoritative: false,
  async run(ctx) {
    const a = (ctx.adapters || await loadAdapters()).hitolink
    const { cfg, env, browser, log, onPage, shouldStop, session } = ctx
    const size = cfg.pageSize.hitolink
    const context = await browser.newContext({ viewport: { width: 1400, height: 1000 } })
    try {
      const page = await context.newPage()
      log('ログイン中…')
      await a.login(page, env)
      let token = await a.getAuthToken(page)
      const relogin = async () => {
        log('再ログインします')
        await a.login(page, env)
        token = await a.getAuthToken(page)
      }
      const body = a.buildQJson({}, {})
      const first = await withRetry(cfg.pageRetry, () => a.apiSearch(page, token, { qJson: body, limit: 1, pageNo: 1 }),
        { log, label: '総数の取得', onRetry: relogin })
      const remoteTotal = first.total
      const pages = Math.ceil((remoteTotal || 0) / size)
      log(`媒体の総数 ${remoteTotal?.toLocaleString()} 件 / ${pages} ページ（${size}件ずつ）`)

      let pagesOk = 0, pagesFailed = 0, consecutive = 0, stopped = false, extra = null
      for (let p = 1; p <= pages + 1; p++) { // +1: 取得中に増えた分の取りこぼし防止
        if (shouldStop()) { stopped = true; break }
        let res
        try {
          res = await withRetry(cfg.pageRetry, () => a.apiSearch(page, token, { qJson: body, limit: size, pageNo: p }),
            { log, label: `p${p}`, onRetry: (e, i) => (i === 1 ? relogin() : null) })
        } catch (e) {
          pagesFailed++
          if (++consecutive >= cfg.maxConsecutiveFail) { extra = `連続${consecutive}ページ失敗で打ち切り`; break }
          continue
        }
        consecutive = 0
        const jobs = res.jobs || []
        if (!jobs.length) break
        pagesOk++
        onPage(jobs.map((raw) => ({ mapped: a.mapApiJob(raw), raw })))
        if (p % 10 === 0 || p === pages) log(`p${p}/${pages} 取得累計 ${session.stats.fetched.toLocaleString()} 件`)
        if (jobs.length < size) break
        if (cfg.pageDelayMs) await sleep(cfg.pageDelayMs)
      }
      return { remoteTotal, pagesOk, pagesFailed, ...judge({ remoteTotal, fetched: session.stats.fetched, pagesFailed, stopped, cfg, extra }) }
    } finally {
      await context.close().catch(() => {})
    }
  },
}

export const DRIVERS = { kintone, hitolink }
