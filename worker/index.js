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
import { mechanicalFilter, evaluateOne } from './filter.js'
import { scoreBatch, scoreBriefBatch } from './scorer.js'

const env = process.env
const APP_URL = env.APP_URL || 'http://localhost:3000'
const TOKEN = env.INGEST_TOKEN || ''
const POLL = parseInt(env.POLL_INTERVAL || '5000', 10)
const HEADLESS = (env.HEADLESS || 'true') === 'true'
const ONCE = process.argv.includes('--once')

const SOURCES = ['circus', 'hitolink', 'jobins']

// ============================================================
// 自律探索エージェントのパラメータ（すべて環境変数で調整可能）
// 方針: 時間がかかってもよい / 上位候補だけ精読 / 1検索100円以内
// ============================================================
const EXPLORE = {
  // 1次粗選別のバッチサイズ（安いので多め）
  BRIEF_BATCH: parseInt(env.BRIEF_BATCH || '25', 10),
  // 2次精読のバッチサイズ
  DEEP_BATCH: parseInt(env.DEEP_BATCH || '8', 10),
  // 探索するページ数の上限（circusは1ページ25件）
  MAX_PAGES: parseInt(env.MAX_PAGES || '200', 10),
  // スキャンする総求人数の上限（安全弁）
  MAX_SCAN: parseInt(env.MAX_SCAN || '5000', 10),
  // 1次スコアがこの値以上なら「精読候補」プールに入れる
  BRIEF_THRESHOLD: parseInt(env.BRIEF_THRESHOLD || '60', 10),
  // 2次(精読)スコアがこの値以上なら最終的にユーザーへ払い出す
  DEEP_THRESHOLD: parseInt(env.DEEP_THRESHOLD || '65', 10),
  // 連続してこのページ数、精読候補がゼロなら早期終了
  STALL_PAGES: parseInt(env.STALL_PAGES || '15', 10),
  // 精読する候補数の上限（コスト管理の要）。topNの数倍を上限に。
  MAX_DEEP: parseInt(env.MAX_DEEP || '60', 10),
  // トークン予算の上限（超えたら探索/精読を打ち切る）。
  // gpt-5-nano は安価だが100円以内を安全に守るための上限。
  TOKEN_BUDGET: parseInt(env.TOKEN_BUDGET || '400000', 10),
  // 時間上限（ミリ秒）。既定2時間。
  TIME_LIMIT_MS: parseInt(env.TIME_LIMIT_MS || String(2 * 60 * 60 * 1000), 10),
}

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

// ============================================================
// 自律探索エージェント本体
//
// 1ページずつ深掘りしながら:
//   機械フィルタ → 1次AI粗選別 → 有望候補をプールに蓄積
// 「連続空振り / ページ上限 / スキャン上限 / 時間上限 / トークン予算」で停止判断。
// 探索後、プール上位を2次AI精読し、スコア順に逐次払い出す。
// ============================================================
async function processSource(browser, source, searchJobId, criteria) {
  const adapter = ADAPTERS[source]
  if (!adapter) return
  // ページ単位のコールバックに対応したアダプタのみ自律探索を行う
  if (typeof adapter.fetchJobsPaged !== 'function') {
    await reportState(searchJobId, source, { phase: 'error', message: `${source} は未対応（ページ探索API未実装）` })
    return
  }

  const context = await browser.newContext({ viewport: { width: 1400, height: 1000 } })
  const page = await context.newPage()
  const startedAt = Date.now()
  const useAI = (criteria.freeText || '').trim().length > 0
  const topN = criteria.topN || 10

  let scanned = 0          // スキャンした総求人数
  let passed = 0           // 機械フィルタ通過数
  let tokens = 0           // 消費トークン累計
  let pagesSeen = 0        // 見たページ数
  let stallPages = 0       // 連続で精読候補ゼロだったページ数
  const pool = []          // 精読候補プール { job, preScore, briefScore }
  const seenIds = new Set()

  // このページ探索を止めるべきか
  const shouldStop = () => {
    if (Date.now() - startedAt > EXPLORE.TIME_LIMIT_MS) return '時間上限'
    if (scanned >= EXPLORE.MAX_SCAN) return 'スキャン上限'
    if (pagesSeen >= EXPLORE.MAX_PAGES) return 'ページ上限'
    if (tokens >= EXPLORE.TOKEN_BUDGET) return 'トークン予算'
    if (stallPages >= EXPLORE.STALL_PAGES) return '連続空振り'
    return null
  }

  try {
    await reportState(searchJobId, source, { phase: 'fetching', message: 'ログイン中…' })
    await adapter.login(page, env)
    await reportState(searchJobId, source, { phase: 'fetching', message: '探索を開始…' })

    let totalInSource = null // 検索結果の総件数（DB全体でこの条件に合う件数）

    // チャンク単位コールバック。求人配列＋meta(total)を受け取り、処理して
    // 「探索を続けるか(true) / 止めるか(false)」を返す。
    const onPage = async (jobsInPage, meta = {}) => {
      if (meta.total != null && totalInSource == null) {
        totalInSource = meta.total
        await reportState(searchJobId, source, {
          phase: 'fetching', totalInDb: totalInSource,
          message: `該当${totalInSource.toLocaleString()}件を探索開始…`,
        })
      }
      pagesSeen++
      // 重複除去
      const fresh = []
      for (const job of jobsInPage) {
        const id = `${source}:${job.sourceJobId}`
        if (job.sourceJobId && seenIds.has(id)) continue
        if (job.sourceJobId) seenIds.add(id)
        fresh.push(job)
      }
      scanned += fresh.length

      // 機械フィルタ（絶対条件で足切り・トークン0）
      const survivors = []
      for (const job of fresh) {
        const ev = evaluateOne(job, criteria)
        if (!ev.hardFail) survivors.push(ev)
      }
      passed += survivors.length

      let candidatesThisPage = 0
      if (survivors.length) {
        if (!useAI) {
          // 要望フリー記述が無い場合は機械スコアで候補化
          for (const ev of survivors) {
            if (ev.preScore >= EXPLORE.BRIEF_THRESHOLD) {
              pool.push({ job: ev.job, preScore: ev.preScore, briefScore: ev.preScore })
              candidatesThisPage++
            }
          }
        } else {
          // 1次AI粗選別（安く大量に）
          for (let i = 0; i < survivors.length; i += EXPLORE.BRIEF_BATCH) {
            const chunk = survivors.slice(i, i + EXPLORE.BRIEF_BATCH)
            const { results, tokensUsed } = await scoreBriefBatch(env, criteria, chunk.map((s) => s.job))
            tokens += tokensUsed
            for (const r of results) {
              if (r.score >= EXPLORE.BRIEF_THRESHOLD) {
                pool.push({ job: chunk[r.index].job, preScore: chunk[r.index].preScore, briefScore: r.score })
                candidatesThisPage++
              }
            }
          }
        }
      }

      if (candidatesThisPage > 0) stallPages = 0
      else stallPages++

      console.log(`[${source}] p${pagesSeen}: scan+${fresh.length}(計${scanned}) 通過${survivors.length} 候補+${candidatesThisPage}(計${pool.length}) 空振り${stallPages} tok${tokens}`)
      await reportState(searchJobId, source, {
        phase: 'fetching', scanned, candidates: pool.length, tokensUsed: tokens,
        totalInDb: totalInSource ?? undefined,
        message: totalInSource
          ? `探索中… ${scanned.toLocaleString()}/${totalInSource.toLocaleString()}件走査 / 有望候補${pool.length}件`
          : `探索中… ${scanned}件走査 / 有望候補${pool.length}件`,
      })

      const stop = shouldStop()
      if (stop) {
        console.log(`[${source}] 探索停止: ${stop}`)
        return false
      }
      return true
    }

    await adapter.fetchJobsPaged(page, criteria, onPage)

    // ---- 2次精読フェーズ ----
    // プールを1次スコア順に並べ、上位 MAX_DEEP 件だけ全文精読する。
    pool.sort((a, b) => b.briefScore - a.briefScore)
    const toDeep = pool.slice(0, EXPLORE.MAX_DEEP)
    console.log(`[${source}] 探索完了: 走査${scanned} / 有望候補${pool.length} / 精読対象${toDeep.length}`)
    await reportState(searchJobId, source, {
      phase: 'scoring', scanned, candidates: pool.length, tokensUsed: tokens,
      message: `上位${toDeep.length}件を精読中…`,
    })

    let matched = 0
    const finalMatches = []
    if (!useAI) {
      for (const c of toDeep) finalMatches.push({ job: c.job, score: c.preScore, reason: '条件一致(機械評価)' })
    } else {
      for (let i = 0; i < toDeep.length; i += EXPLORE.DEEP_BATCH) {
        if (tokens >= EXPLORE.TOKEN_BUDGET) { console.log(`[${source}] 精読中断: トークン予算`); break }
        const batch = toDeep.slice(i, i + EXPLORE.DEEP_BATCH).map((c) => c.job)
        const { results, tokensUsed } = await scoreBatch(env, criteria, batch)
        tokens += tokensUsed
        for (const r of results) {
          if (r.score >= EXPLORE.DEEP_THRESHOLD) {
            finalMatches.push({ job: batch[r.index], score: r.score, reason: r.reason })
          }
        }
        await reportState(searchJobId, source, {
          phase: 'scoring', scanned, candidates: pool.length, tokensUsed: tokens,
          message: `精読中… (${finalMatches.length}件合致)`,
        })
      }
    }

    // スコア順に並べ、上位から逐次払い出し（topN件）
    finalMatches.sort((a, b) => b.score - a.score)
    for (const m of finalMatches.slice(0, topN)) {
      await pushResult(searchJobId, m.job, m.score, m.reason)
      matched++
    }

    await reportState(searchJobId, source, {
      phase: 'done', matched, tokensUsed: tokens, totalInDb: totalInSource ?? scanned, scanned,
      candidates: pool.length,
      message: `完了: 該当${(totalInSource ?? scanned).toLocaleString()}件中${scanned}件走査→${pool.length}件精査→${matched}件を提案 (トークン約${tokens})`,
    })
  } catch (e) {
    console.error(`[${source}] error:`, e)
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
