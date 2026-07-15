// ============================================================
// 外部スクレイピングワーカー (手元PC / VPS で実行)
//
// 役割:
//  1) Cloudflare側の /api/ingest/pending をポーリングし、実行待ちの検索ジョブを取得
//  2) ①②③にログインしてスクレイピング（adapters.js）
//  3) 機械フィルタ + AI採点 で一致度を評価
//  4) 見つけ次第 /api/ingest/result へ逐次POST（払い出し）
//  5) 進捗を /api/ingest/state へ報告（AI担当の可視化）
//
// 使い方:
//   cd worker
//   cp .env.example .env   # 値を設定
//   npm install            # playwright chromium も自動DL
//   npm start              # 常駐ポーリング  /  npm run start:once で1回だけ
// ============================================================

import dotenv from 'dotenv'
// override:true → シェルに既存の同名環境変数があっても .env の値を優先する
// （サンドボックスには無効な OPENAI_API_KEY が設定済みのことがあるため必須）
dotenv.config({ override: true })
import { chromium } from 'playwright'
import { ADAPTERS } from './adapters.js'
import { mechanicalFilter } from './filter.js'
import { scoreBatch } from './scorer.js'

const env = process.env
const APP_URL = env.APP_URL || 'http://localhost:3000'
const TOKEN = env.INGEST_TOKEN || ''
const POLL = parseInt(env.POLL_INTERVAL || '5000', 10)
const HEADLESS = (env.HEADLESS || 'true') === 'true'
const ONCE = process.argv.includes('--once')

const SOURCES = ['circus', 'hitolink', 'jobins']
const AI_BATCH = 10
const MAX_AI = 40
const THRESHOLD = 55

async function api(path, opts = {}) {
  const res = await fetch(`${APP_URL}${path}`, {
    ...opts,
    headers: { 'Content-Type': 'application/json', 'X-Ingest-Token': TOKEN, ...(opts.headers || {}) },
  })
  if (!res.ok) throw new Error(`${path} -> ${res.status}`)
  return res.json()
}

async function reportState(searchJobId, source, patch) {
  try {
    await api('/api/ingest/state', {
      method: 'POST',
      body: JSON.stringify({ searchJobId, source, ...patch }),
    })
  } catch (e) {
    console.error('reportState failed', e.message)
  }
}

async function pushResult(searchJobId, job, score, reason) {
  try {
    await api('/api/ingest/result', {
      method: 'POST',
      body: JSON.stringify({ searchJobId, job, score, reason }),
    })
  } catch (e) {
    console.error('pushResult failed', e.message)
  }
}

// 1つのDBについて1つの検索ジョブを処理
async function processSource(browser, source, searchJobId, criteria) {
  const adapter = ADAPTERS[source]
  if (!adapter) return

  const context = await browser.newContext()
  const page = await context.newPage()
  let scanned = 0
  const collected = []

  try {
    await reportState(searchJobId, source, { phase: 'fetching', message: 'ログイン中…' })
    await adapter.login(page, env)

    await reportState(searchJobId, source, { phase: 'fetching', message: '求人を取得中…' })
    await adapter.fetchJobs(page, criteria, async (job) => {
      scanned++
      collected.push(job)
      if (scanned % 20 === 0) {
        await reportState(searchJobId, source, { phase: 'fetching', scanned, message: `取得中… ${scanned}件` })
      }
    })

    await reportState(searchJobId, source, { phase: 'filtering', scanned, totalInDb: scanned, message: `${scanned}件を絞り込み中…` })
    const filtered = mechanicalFilter(collected, criteria)
    console.log(`[${source}] 取得${collected.length}件 → フィルタ通過${filtered.length}件`)
    if (filtered.length) console.log(`[${source}] preScore上位:`, filtered.slice(0, 5).map((f) => `${f.preScore}(${(f.job.locations || []).join(',')})`).join(' '))
    await reportState(searchJobId, source, { phase: 'scoring', candidates: filtered.length, message: 'AIで採点中…' })

    const useAI = (criteria.freeText || '').trim().length > 0
    let matched = 0
    let tokens = 0
    const candidates = filtered.slice(0, MAX_AI)

    if (!useAI) {
      for (const f of candidates.slice(0, criteria.topN)) {
        await pushResult(searchJobId, f.job, f.preScore, '条件一致(機械評価)')
        matched++
      }
    } else {
      for (let i = 0; i < candidates.length && matched < criteria.topN; i += AI_BATCH) {
        const batch = candidates.slice(i, i + AI_BATCH).map((b) => b.job)
        const { results, tokensUsed } = await scoreBatch(env, criteria, batch)
        tokens += tokensUsed
        const scored = results
          .map((r) => ({ job: batch[r.index], score: r.score, reason: r.reason }))
          .sort((a, b) => b.score - a.score)
        console.log(`[${source}] AIスコア:`, scored.map((s) => s.score).join(','))
        for (const s of scored) {
          if (s.score >= THRESHOLD) {
            await pushResult(searchJobId, s.job, s.score, s.reason)
            matched++
          }
        }
        await reportState(searchJobId, source, { phase: 'scoring', matched, tokensUsed: tokens, message: `採点中… (${matched}件マッチ)` })
      }
    }

    await reportState(searchJobId, source, {
      phase: 'done', matched, tokensUsed: tokens, totalInDb: scanned, scanned,
      candidates: filtered.length,
      message: `完了: ${matched}件を提案 (消費トークン約${tokens})`,
    })
  } catch (e) {
    await reportState(searchJobId, source, { phase: 'error', message: `エラー: ${String(e.message).slice(0, 180)}` })
  } finally {
    await context.close()
  }
}

async function tick(browser) {
  for (const source of SOURCES) {
    try {
      const { jobs } = await api(`/api/ingest/pending?source=${source}`)
      for (const j of jobs) {
        console.log(`[${source}] 処理開始 job=${j.searchJobId}`)
        await processSource(browser, source, j.searchJobId, j.criteria)
      }
    } catch (e) {
      console.error(`[${source}] pending取得失敗:`, e.message)
    }
  }
}

async function main() {
  console.log(`外部ワーカー起動  APP_URL=${APP_URL}  headless=${HEADLESS}`)
  if (!TOKEN) console.warn('⚠️ INGEST_TOKEN が未設定です。.env を確認してください。')
  const browser = await chromium.launch({ headless: HEADLESS })

  if (ONCE) {
    await tick(browser)
    await browser.close()
    return
  }

  // 常駐ポーリング
  while (true) {
    await tick(browser)
    await new Promise((r) => setTimeout(r, POLL))
  }
}

main().catch((e) => {
  console.error('fatal:', e)
  process.exit(1)
})
