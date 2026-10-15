// ============================================================
// 調査: ジョビンズの「求人ごとの詳細ページ」のURL形式を調べる（読み取りのみ）
//   画面の検索結果で求人をクリックしたときに開くURLを記録する。
//   使い方（VPS）: cd /home/ubuntu/webapp/worker && node stage0_probe_jobins_url.js
// ============================================================
import dotenv from 'dotenv'
dotenv.config({ override: true })
import { chromium } from 'playwright'
import { ADAPTERS } from './adapters.js'

const a = ADAPTERS.jobins
const browser = await chromium.launch({ headless: true })
const ctx = await browser.newContext({
  userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  locale: 'ja-JP', viewport: { width: 1366, height: 768 },
})
await ctx.addInitScript(() => { Object.defineProperty(navigator, 'webdriver', { get: () => undefined }) })
const page = await ctx.newPage()
try {
  await a.login(page, process.env)
  const token = await a.getAuthToken(page)
  const r = await a.apiSearch(page, token, { qJson: a.buildQJson({}, {}), limit: 3, pageNo: 1 })
  const j = r.jobs[0]
  console.log('API の求人の識別子:', JSON.stringify({ id: j.id, uuid: j.uuid, vacancy_no: j.vacancy_no, job_title: j.job_title }))
  console.log('URLらしき項目:', JSON.stringify(Object.fromEntries(Object.entries(j).filter(([k, v]) => /url|link|path|slug/i.test(k) || (typeof v === 'string' && /^https?:|^\//.test(v))))))

  // 検索画面で1件目をクリックして、開いたURLを記録
  await page.goto('https://jobins.jp/agent/job/search_1#/', { waitUntil: 'networkidle', timeout: 60000 }).catch(() => {})
  await page.waitForTimeout(4000)
  const links = await page.$$eval('a[href]', (as) => as.map((x) => x.href).filter((h) => /job/i.test(h) && !/search_1/.test(h)).slice(0, 15))
  console.log('画面内の求人リンク候補:', JSON.stringify([...new Set(links)], null, 1))
  const popupP = ctx.waitForEvent('page', { timeout: 8000 }).catch(() => null)
  const card = await page.$('[class*="job"] a, a[href*="/job/"], [class*="card"]')
  if (card) {
    await card.click().catch(() => {})
    const popup = await popupP
    await page.waitForTimeout(3000)
    console.log('クリック後のURL:', popup ? popup.url() : page.url())
  } else {
    console.log('クリックできる求人カードが見つかりませんでした')
  }
} catch (e) {
  console.error('エラー:', e.message)
} finally {
  await browser.close()
}
