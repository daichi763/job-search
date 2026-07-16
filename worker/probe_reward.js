// 成果報酬フィールド名の確認プローブ（VPSで実行）
//   使い方: cd worker && node probe_reward.js
//   circusにログイン→jobSearchで1ページ取得→生jobオブジェクトの全キーと
//   報酬らしき値を洗い出す。extractReward()の候補キー名を実データで確定するため。
import dotenv from 'dotenv'
dotenv.config({ override: true })
import { chromium } from 'playwright'
import { ADAPTERS } from './adapters.js'

const env = process.env
const a = ADAPTERS.circus

const browser = await chromium.launch({ headless: (env.HEADLESS||'true')==='true' })
const ctx = await browser.newContext()
const page = await ctx.newPage()
try {
  await a.login(page, env)
  const token = await a.getAuthToken(page)
  const qJson = a.buildQJson({ or: '' })
  const resp = await a.apiSearch(page, token, { qJson, filters: {}, limit: 5, offset: 0, pageNo: 1 })
  const jobs = resp.jobs || []
  console.log(`取得 ${jobs.length} 件`)
  if (jobs.length) {
    const raw = jobs[0]
    console.log('\n=== 生jobの全キー ===')
    console.log(Object.keys(raw).join(', '))
    console.log('\n=== 報酬/手数料らしきキーと値 ===')
    const reKey = /(reward|fee|commission|referral|success|rate|percent|手数料|報酬|紹介)/i
    for (const [k, v] of Object.entries(raw)) {
      if (reKey.test(k)) console.log(`  ${k} =`, JSON.stringify(v))
    }
    console.log('\n=== ネストobjで報酬を含むもの ===')
    for (const [k, v] of Object.entries(raw)) {
      if (v && typeof v === 'object') {
        const s = JSON.stringify(v)
        if (reKey.test(s)) console.log(`  ${k} =`, s.slice(0, 300))
      }
    }
    console.log('\n=== extractReward結果 ===')
    console.log(JSON.stringify(a.extractReward(raw)))
    console.log('\n=== 生jobサンプル(先頭1件,全文) ===')
    console.log(JSON.stringify(raw, null, 2).slice(0, 3000))
  }
} catch (e) {
  console.error('probe error:', e)
} finally {
  await browser.close()
}
