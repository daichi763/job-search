#!/usr/bin/env node
// ============================================================
// 検索の動作確認（読み取りのみ）
//   node --no-warnings bin/search.js 営業 --prefecture=東京都 --salaryMin=4000000
//   node --no-warnings bin/search.js --bench          # 速度測定
// ============================================================
import { openDb } from '../lib/db.js'
import { config } from '../lib/env.js'
import { searchJobs } from '../lib/search.js'

const args = process.argv.slice(2)
const q = {}
for (const a of args) {
  if (a.startsWith('--') && a.includes('=')) { const [k, ...v] = a.slice(2).split('='); q[k] = v.join('=') }
}
const keyword = args.filter((a) => !a.startsWith('--')).join(' ')
if (keyword) q.keyword = keyword

const db = openDb(config().dbPath, { readonly: true })
const time = (fn) => { const t = performance.now(); const r = fn(); return [r, performance.now() - t] }

if (args.includes('--bench')) {
  const cases = [
    { keyword: '営業' }, { keyword: '経理' }, { keyword: 'エンジニア' }, { keyword: '法人営業 未経験' },
    { keyword: '営業', prefecture: '東京都', salaryMin: 4000000 }, { prefecture: '大阪府', age: 35 }, {},
  ]
  for (const c of cases) {
    searchJobs(db, c) // 1回目はキャッシュ温め
    const [r, ms] = time(() => searchJobs(db, c))
    console.log(`${JSON.stringify(c).padEnd(60)} ${String(r.total).padStart(7)}件  ${ms.toFixed(1)} ms`)
  }
} else {
  const [r, ms] = time(() => searchJobs(db, q))
  console.log(`条件: ${JSON.stringify(q)}\n該当 ${r.total.toLocaleString()} 件（${ms.toFixed(1)} ms）\n`)
  for (const j of r.jobs) {
    const sal = j.salary_min || j.salary_max ? `${j.salary_min ? Math.round(j.salary_min / 10000) : '?'}〜${j.salary_max ? Math.round(j.salary_max / 10000) : '?'}万円` : '年収不明'
    console.log(`[${j.source}] ${j.title}\n   ${j.company || ''} / ${j.locations_text || ''} / ${sal}${j.features?.length ? ' / ' + j.features.join(',') : ''}`)
  }
}
db.close()
