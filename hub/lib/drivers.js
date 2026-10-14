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

// 1回の通信に上限時間を設ける（媒体が応答を返さないまま固まると、同期全体が止まってしまうため）
export function withTimeout(ms, fn, label = '通信') {
  return (...args) => new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`${label}が${Math.round(ms / 1000)}秒以内に応答しませんでした（status=timeout）`)), ms)
    Promise.resolve().then(() => fn(...args)).then(
      (v) => { clearTimeout(t); resolve(v) },
      (e) => { clearTimeout(t); reject(e) })
  })
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
// ページ番号で全件を読む共通処理（ヒトリンク / ジョビンズ / circus）
//   fetchPage(pageNo) → { total, jobs }
//   ・1ページを最大 pageRetry 回試す（1回目の失敗時は再ログイン）
//   ・取れないページは飛ばして先へ進む（その回は「読み切れていない」扱い＝掲載終了の判定なし）
//   ・連続 maxConsecutiveFail ページ失敗で打ち切り
//   ・最終ページ＋1ページまで読む（取得中に件数が増えた分の取りこぼし防止）
// ------------------------------------------------------------
async function pagedRun(ctx, { a, size, fetchPage, relogin }) {
  const { cfg, log, onPage, shouldStop, session } = ctx
  // 再ログインは認証切れが疑われる時だけ（サーバー側の 500 エラーでは再ログインしても直らない）
  const reloginIfAuth = (e) => (relogin && !/status=5\d\d/.test(String(e && e.message)) ? relogin() : null)
  const first = await withRetry(cfg.pageRetry, () => fetchPage(1, 1), { log, label: '総数の取得', onRetry: reloginIfAuth })
  const remoteTotal = first.total
  if (remoteTotal == null) throw new Error('媒体の総数を取得できませんでした')
  const pages = Math.ceil(remoteTotal / size)
  log(`媒体の総数 ${remoteTotal.toLocaleString()} 件 / ${pages} ページ（${size}件ずつ）`)
  // 範囲指定（取りこぼし分だけ読む）: 指定ページだけ読む。全件ではないので掲載終了の判定はしない
  const range = ctx.pageRange
  const pFrom = range ? Math.max(1, range[0]) : 1
  const pTo = range ? Math.min(range[1], pages + 1) : pages + 1
  if (range) log(`範囲指定: p${pFrom}〜p${pTo}（${(pTo - pFrom + 1)}ページ）だけ読みます`)
  const every = Math.max(1, Math.round((pTo - pFrom + 1) / 12))
  const t0 = Date.now()
  const take = (jobs) => onPage(jobs.map((raw) => ({ mapped: a.mapApiJob(raw), raw })))
  const tryPage = (p, limit, label) => withRetry(cfg.pageRetry, () => fetchPage(p, limit),
    { log, label, onRetry: (e, i) => (i === 1 ? reloginIfAuth(e) : null) })

  let pagesOk = 0, consecutive = 0, stopped = false, extra = null
  const failed = [] // 取れなかったページ番号（あとで取り直す）
  for (let p = pFrom; p <= pTo; p++) {
    if (shouldStop()) { stopped = true; break }
    let res
    try {
      res = await tryPage(p, size, `p${p}`)
    } catch (e) {
      failed.push(p)
      log(`p${p} を後で取り直します`)
      if (++consecutive >= cfg.maxConsecutiveFail) { extra = `連続${consecutive}ページ失敗で打ち切り`; break }
      continue
    }
    consecutive = 0
    const jobs = res.jobs || []
    if (!jobs.length) break
    pagesOk++
    take(jobs)
    if ((p - pFrom + 1) % every === 0 || p === pages) {
      const min = (Date.now() - t0) / 60000
      const done = p - pFrom + 1, rest = pTo - p
      const eta = rest > 0 && p < pages ? ` / 残り約${Math.ceil(min / done * rest)}分` : ''
      log(`p${p}/${pages} 取得累計 ${session.stats.fetched.toLocaleString()} 件（${min.toFixed(0)}分経過${eta}）`)
    }
    if (jobs.length < size) break
    if (cfg.pageDelayMs) await sleep(cfg.pageDelayMs)
  }

  // ---- 取れなかったページの取り直し ----
  //   1) 少し時間を置いて同じページをもう一度
  //   2) それでも駄目なら細かく分けて（既定25件ずつ）取り直す
  //   3) さらに失敗した小分けは1件ずつ（各1回だけ）取り直す
  //      → 壊れた1件だけがエラーの原因になっている場合でも、残りは取れる
  //   取り直しの最中に順番が少しずれて前後と重複することがあるが、重複は同期エンジンが1件にまとめる。
  let unreadable = 0, recovered = 0, notTried = 0
  if (failed.length && !stopped && !extra) {
    log(`取れなかった ${failed.length} ページを取り直します: p${failed.join(', p')}`)
    await sleep(cfg.recoverWaitMs)
    const sub = Math.max(1, Math.min(cfg.recoverChunk, size))
    for (const p of failed) {
      if (shouldStop()) { stopped = true; notTried++; continue }
      try {
        take((await tryPage(p, size, `取り直し p${p}`)).jobs || [])
        log(`p${p} 取り直し成功`); recovered++
        continue
      } catch {}
      if (size % sub !== 0 || sub === size) { unreadable += size; continue }
      const per = size / sub
      let lost = 0
      for (let k = 1; k <= per; k++) {
        const subPage = (p - 1) * per + k
        try {
          take((await tryPage(subPage, sub, `取り直し p${p} の小分け${k}/${per}`)).jobs || [])
        } catch {
          for (let j = 1; j <= sub; j++) {
            const nth = (subPage - 1) * sub + j // 何件目か
            if (shouldStop()) { lost += sub - j + 1; break }
            try { take((await fetchPage(nth, 1)).jobs || []) }
            catch { lost++; log(`${nth}件目の求人はどうしても取得できません`) }
          }
        }
        if (cfg.pageDelayMs) await sleep(cfg.pageDelayMs)
      }
      unreadable += lost
      if (!lost) recovered++
      log(lost ? `p${p} 取り直し: ${lost} 件だけ取得できませんでした` : `p${p} 小分けで取り直し成功`)
    }
  }
  if (notTried) extra = extra || '時間切れで取り直しができませんでした'
  if (range) extra = extra || '範囲指定の取り直し（全件ではない）'
  if (stopped && failed.length && !recovered) extra = extra || `${failed.length}ページ取得失敗`
  let unreadNote = null
  if (unreadable > cfg.maxUnreadable) unreadNote = `${unreadable}件取得できず`
  else if (unreadable) log(`取得できなかった ${unreadable} 件は許容範囲（HUB_MAX_UNREADABLE=${cfg.maxUnreadable}）として扱います`)
  return {
    remoteTotal, pagesOk, pagesFailed: failed.length - recovered, pagesRecovered: recovered, unreadable,
    ...judge({ remoteTotal, fetched: session.stats.fetched, pagesFailed: 0, stopped, cfg, extra: extra || unreadNote }),
  }
}

// ブラウザの用意（ジョビンズは不正アクセス対策で Windows の Chrome に見せる必要がある＝既存 worker と同じ設定）
async function newContext(browser, source) {
  const opts = { viewport: { width: 1400, height: 1000 } }
  if (source === 'jobins') {
    opts.userAgent = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
    opts.locale = 'ja-JP'
    opts.viewport = { width: 1366, height: 768 }
    opts.extraHTTPHeaders = { 'Accept-Language': 'ja-JP,ja;q=0.9,en;q=0.8' }
  }
  const context = await browser.newContext(opts)
  if (source === 'jobins' && context.addInitScript) {
    await context.addInitScript(() => { Object.defineProperty(navigator, 'webdriver', { get: () => undefined }) })
  }
  return context
}

// ログイン → 認証情報の取得 → 全件読み込み、の共通の流れ
async function browserRun(ctx, source, { size, makeFetch, useLogout = false }) {
  const a = (ctx.adapters || await loadAdapters())[source]
  const { env, browser, log } = ctx
  const context = await newContext(browser, source)
  try {
    const page = await context.newPage()
    log('ログイン中…')
    await a.login(page, env)
    let token
    try {
      token = await a.getAuthToken(page)
    } catch (e) {
      if (!useLogout || typeof a.logout !== 'function') throw e
      log(`認証情報の取得に失敗、ログアウトして入り直します: ${e.message}`)
      await a.logout(page); await a.login(page, env); token = await a.getAuthToken(page)
    }
    const relogin = async () => {
      log('再ログインします')
      if (useLogout && typeof a.logout === 'function') await a.logout(page)
      await a.login(page, env)
      token = await a.getAuthToken(page)
    }
    const fetchPage = withTimeout(ctx.cfg.requestTimeoutMs, makeFetch({ a, page, getToken: () => token }), '媒体')
    return await pagedRun(ctx, { a, size, fetchPage, relogin })
  } finally {
    await context.close().catch(() => {})
  }
}

// ------------------------------------------------------------
// ヒトリンク: 内部API。1回 1,000件（実測 107,222件 / 約9分）
// ------------------------------------------------------------
export const hitolink = {
  source: 'hitolink',
  needsBrowser: true,
  authoritative: false,
  run: (ctx) => browserRun(ctx, 'hitolink', {
    size: ctx.cfg.pageSize.hitolink,
    makeFetch: ({ a, page, getToken }) => {
      const body = a.buildQJson({}, {})
      return (pageNo, limit) => a.apiSearch(page, getToken(), { qJson: body, limit, pageNo })
    },
  }),
}

// ------------------------------------------------------------
// ジョビンズ: REST API。1回 100件が上限（200件以上は 422 エラー）。約40分の見込み
//   並び順の指定は効かないため既定の順で全ページを読む
// ------------------------------------------------------------
export const jobins = {
  source: 'jobins',
  needsBrowser: true,
  authoritative: false,
  run: (ctx) => browserRun(ctx, 'jobins', {
    size: ctx.cfg.pageSize.jobins,
    makeFetch: ({ a, page, getToken }) => {
      const body = a.buildQJson({}, {})
      return (pageNo, limit) => a.apiSearch(page, getToken(), { qJson: body, limit, pageNo })
    },
  }),
}

// ------------------------------------------------------------
// circus: 内部REST API。1回 200件（1回 約6秒）。約1.5時間の見込み
//   並び順は「掲載開始日の新しい順」に固定する。
//   既定の「おすすめ順」は読んでいる間に順位が入れ替わりやすく、取りこぼしの原因になるため。
//   同時ログインは1セッションまで → 再ログイン時は一度ログアウトしてから入り直す
// ------------------------------------------------------------
export const circus = {
  source: 'circus',
  needsBrowser: true,
  authoritative: false,
  run: (ctx) => browserRun(ctx, 'circus', {
    size: ctx.cfg.pageSize.circus,
    useLogout: true,
    makeFetch: ({ a, page, getToken }) => {
      const qJson = a.buildQJson({})
      const orderBy = ctx.cfg.circusOrderBy
      return async (pageNo, limit) => {
        const offset = (pageNo - 1) * limit
        const { status, json } = await page.evaluate(async ({ token, qJson, limit, offset, pageNo, orderBy, timeoutMs }) => {
          const qs = new URLSearchParams()
          for (const q of qJson) qs.append('qJson', JSON.stringify(q))
          qs.set('limit', String(limit)); qs.set('offset', String(offset)); qs.set('page', String(pageNo))
          qs.set('orderBy', orderBy); qs.set('order', 'desc')
          const res = await fetch('https://circus-job.com/api/jobSearch?' + qs.toString(), {
            signal: AbortSignal.timeout(timeoutMs),
            credentials: 'include',
            headers: { accept: 'application/json, text/plain, */*', 'x-circus-authentication-token': token },
          })
          let json = null
          try { json = await res.json() } catch {}
          return { status: res.status, json }
        }, { token: getToken(), qJson, limit, offset, pageNo, orderBy, timeoutMs: ctx.cfg.requestTimeoutMs - 5000 })
        if (status !== 200 || !json) throw new Error(`circus status=${status}`)
        return { total: json.total ?? null, jobs: Array.isArray(json.jobs) ? json.jobs : [] }
      }
    },
  }),
}

export const DRIVERS = { kintone, hitolink, jobins, circus }
