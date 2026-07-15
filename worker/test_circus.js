// circusアダプタ単体テスト: ログイン→数件だけ取得して表示
import 'dotenv/config'
import { chromium } from 'playwright'
import { circusAdapter } from './adapters.js'

const env = process.env
const browser = await chromium.launch({ headless: (env.HEADLESS || 'true') === 'true' })
const ctx = await browser.newContext({
  userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120.0 Safari/537.36',
  viewport: { width: 1366, height: 900 },
})
const page = await ctx.newPage()

const criteria = { topN: 8, freeText: '営業', _maxScan: 8 } // テスト: キーワード「営業」で8件

try {
  console.log('ログイン中...')
  await circusAdapter.login(page, env)
  console.log('ログイン成功。求人取得中...')

  let count = 0
  await circusAdapter.fetchJobs(page, criteria, async (job) => {
    count++
    if (count > 5) return // 表示は5件まで（打ち切りは maxScan 依存）
    console.log(`\n[${count}] ${job.title}`)
    console.log(`  id=${job.sourceJobId} open=${job.isOpen}`)
    console.log(`  企業=${job.company} 職種=${job.jobCategory} 雇用=${job.employment}`)
    console.log(`  年収=${job.salaryMin}~${job.salaryMax} 勤務地=${job.locations.join(',')}`)
    console.log(`  必須条件=${(job.requirements || '').replace(/\n/g, ' ').slice(0, 80)}`)
    console.log(`  説明=${(job.description || '').replace(/\n/g, ' ').slice(0, 100)}`)
  })
  console.log(`\n取得総数: ${count}件`)
} catch (e) {
  console.error('ERROR:', e.message)
} finally {
  await browser.close()
  console.log('\n完了')
}
