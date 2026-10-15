// ============================================================
// 調査（第2弾）: ジョビンズの「求人ごとの詳細ページ」のURL形式を調べる（読み取りのみ）
//
//   分かっていること
//     ・詳細ページは https://jobins.jp/agent/job/detail/<暗号化されたID>?activeTab=job-description
//       （<暗号化されたID> は eyJpdiI6... で始まる文字列。サーバー側で求人IDを暗号化したもの）
//     ・一覧API（/api/agent/job/search）の各求人には URL が入っていない
//   調べること
//     1) 一覧APIの各求人に、暗号化IDらしき項目（eyJ で始まる文字列）があるか（入れ子も含めて全探索）
//     2) 詳細API（/api/agent/job/... ）に uuid / id / vacancy_no を渡すと暗号化IDが返るか
//     3) 画面（Vueの検索画面）で1件目の求人をクリックしたときに開くURLと、その前後の通信
//
//   使い方（VPS）: cd /home/ubuntu/webapp/worker && node stage0_probe_jobins_url.js
//   出力の「結果まとめ」をそのまま共有してください（個人情報は含みません）
// ============================================================
import dotenv from 'dotenv'
dotenv.config({ override: true })
import { chromium } from 'playwright'
import { ADAPTERS } from './adapters.js'

const a = ADAPTERS.jobins
const summary = []
const note = (k, v) => { summary.push([k, v]); console.log(`■ ${k}:`, typeof v === 'string' ? v : JSON.stringify(v)) }

// オブジェクトの中から条件に合う値を探す（パスを返す）
function findPaths(obj, pred, base = '', out = [], depth = 0) {
  if (obj == null || depth > 6 || out.length > 30) return out
  if (typeof obj !== 'object') { if (pred(obj)) out.push([base, String(obj).slice(0, 120)]); return out }
  for (const [k, v] of Object.entries(obj)) findPaths(v, pred, base ? `${base}.${k}` : k, out, depth + 1)
  return out
}

const browser = await chromium.launch({ headless: true })
const ctx = await browser.newContext({
  userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  locale: 'ja-JP', viewport: { width: 1366, height: 768 },
})
await ctx.addInitScript(() => { Object.defineProperty(navigator, 'webdriver', { get: () => undefined }) })
const page = await ctx.newPage()

// 通信の記録（求人詳細に関係しそうなものだけ）
const traffic = []
page.on('response', async (res) => {
  const u = res.url()
  if (!/api\.jobins\.jp|jobins\.jp\/agent\/job/.test(u) || /\.(js|css|png|svg|woff)/.test(u)) return
  let body = ''
  try { if ((res.headers()['content-type'] || '').includes('json')) body = (await res.text()).slice(0, 4000) } catch {}
  traffic.push({ status: res.status(), method: res.request().method(), url: u.slice(0, 300), body })
})

try {
  await a.login(page, process.env)
  const token = await a.getAuthToken(page)
  const r = await a.apiSearch(page, token, { qJson: a.buildQJson({}, {}), limit: 3, pageNo: 1 })
  const j = r.jobs[0]
  note('一覧APIの識別子', { id: j.id, uuid: j.uuid, vacancy_no: j.vacancy_no })
  note('一覧APIの項目名', Object.keys(j))
  note('一覧APIの中の暗号化IDらしき値', findPaths(j, (v) => typeof v === 'string' && /^eyJ[A-Za-z0-9+/=]{20,}/.test(v)))
  note('一覧APIの中のURL・パスらしき値', findPaths(j, (v) => typeof v === 'string' && /(^https?:|^\/agent\/|detail)/.test(v)))

  // 2) 詳細APIの候補を順に試す（GETのみ・読み取り）
  const cands = [
    `/api/agent/job/${j.uuid}`, `/api/agent/job/${j.id}`, `/api/agent/job/detail/${j.uuid}`, `/api/agent/job/detail/${j.id}`,
    `/api/agent/jobs/${j.uuid}`, `/api/agent/jobs/${j.id}`, `/api/agent/job/${j.uuid}/detail`, `/api/agent/job/encrypt/${j.id}`,
  ]
  const tried = await page.evaluate(async ({ cands, token }) => {
    const out = []
    for (const p of cands) {
      try {
        const res = await fetch(`https://api.jobins.jp${p}`, { headers: { accept: 'application/json', authorization: token ? `Bearer ${token}` : undefined }, credentials: 'include' })
        const t = await res.text()
        out.push({ path: p, status: res.status, eyJ: (t.match(/eyJ[A-Za-z0-9+/=]{20,}/) || [null])[0], head: t.slice(0, 200) })
      } catch (e) { out.push({ path: p, error: String(e).slice(0, 100) }) }
    }
    return out
  }, { cands, token })
  note('詳細APIの候補', tried.map((x) => `${x.status ?? 'ERR'} ${x.path}${x.eyJ ? ' ← 暗号化IDあり' : ''}`))

  // 3) 画面で1件目をクリック
  await page.goto('https://jobins.jp/agent/job/search_1#/', { waitUntil: 'networkidle', timeout: 60000 }).catch(() => {})
  await page.waitForTimeout(5000)
  const hrefs = await page.$$eval('a[href]', (as) => as.map((x) => x.href).filter((h) => /job\/detail/.test(h)).slice(0, 5))
  note('画面内の詳細リンク', hrefs)
  const before = traffic.length
  const popupP = ctx.waitForEvent('page', { timeout: 10000 }).catch(() => null)
  // 求人タイトルらしき要素（API の job_title と同じ文字）を探してクリック
  const title = String(r.jobs[0].job_title || '').slice(0, 12)
  let clicked = false
  for (const sel of [`text=${title}`, 'a[href*="job/detail"]', '[class*="job-title"]', '[class*="jobTitle"]', '[class*="title"] >> nth=0']) {
    const el = await page.$(sel).catch(() => null)
    if (el) { await el.click().catch(() => {}); clicked = sel; break }
  }
  note('クリックした要素', clicked || 'なし')
  const popup = await popupP
  await page.waitForTimeout(4000)
  note('クリック後のURL', popup ? popup.url() : page.url())
  note('クリック前後の通信', traffic.slice(before).map((t) => `${t.status} ${t.method} ${t.url}${/eyJ/.test(t.body) ? ' ← 暗号化IDあり' : ''}`).slice(0, 15))
  const enc = traffic.map((t) => (t.body.match(/eyJ[A-Za-z0-9+/=]{20,}/) || [])[0]).filter(Boolean)
  note('通信の中の暗号化ID（先頭3件）', enc.slice(0, 3).map((s) => s.slice(0, 40) + '…'))
} catch (e) {
  console.error('エラー:', e.message)
} finally {
  console.log('\n===== 結果まとめ（これを共有してください） =====')
  for (const [k, v] of summary) console.log(`${k}: ${typeof v === 'string' ? v : JSON.stringify(v)}`)
  await browser.close()
}
