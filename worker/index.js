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
import { mechanicalFilter, evaluateOne, evaluateDetail } from './filter.js'
import { scoreBatch, scoreBriefBatch, buildSearchPlans, scoreRelaxBatch } from './scorer.js'
import { analyzeResumePdf, resumeAnalysisToText } from './resume.js'

// 職務経歴書(PDF)解析結果のキャッシュ。
//   同一検索ジョブは複数媒体(circus/hitolink...)で processSource が呼ばれるため、
//   PDF解析(pdf-parse + OpenAI)を searchJobId 単位で1回だけ実行して使い回す。
//   値: { text: 反映用テキスト, analysis: 構造化, done: true }
const resumeCache = new Map()

// 検索ジョブの criteria に添付PDFがあれば解析し、criteria.resumeText へ反映する。
//   ・解析後、元の base64(criteria.resumePdfBase64) は削除する（＝完了後に破棄）。
//   ・PDFが無い/解析失敗でも criteria はそのまま使える（書類なしでも動作）。
async function ensureResumeAnalyzed(searchJobId, criteria) {
  if (!criteria) return
  // 既に反映済みなら何もしない
  if (criteria.resumeText) return
  const b64 = criteria.resumePdfBase64
  if (!b64) return

  // キャッシュヒット（他媒体で解析済み）
  if (resumeCache.has(searchJobId)) {
    const cached = resumeCache.get(searchJobId)
    if (cached && cached.text) {
      criteria.resumeText = cached.text
      criteria.resumeAnalysis = cached.analysis
    }
    delete criteria.resumePdfBase64 // 破棄
    return { status: cached ? cached.status : 'skipped' }
  }

  console.log(`[resume] 職務経歴書PDFを解析中… job=${searchJobId}`)
  try {
    const r = await analyzeResumePdf(env, b64)
    if (r.ok) {
      const text = resumeAnalysisToText(r.analysis)
      resumeCache.set(searchJobId, { text, analysis: r.analysis, done: true, status: 'ok' })
      criteria.resumeText = text
      criteria.resumeAnalysis = r.analysis
      console.log(`[resume] 解析成功 tokens=${r.tokensUsed} 経験職種=${(r.analysis?.jobTypes || []).join(',')}`)
      return { status: 'ok', analysis: r.analysis }
    } else {
      resumeCache.set(searchJobId, { text: '', analysis: null, done: true, status: 'failed', error: r.error })
      console.log(`[resume] 解析スキップ: ${r.error}`)
      return { status: 'failed', error: r.error }
    }
  } catch (e) {
    resumeCache.set(searchJobId, { text: '', analysis: null, done: true, status: 'failed', error: e.message })
    console.log(`[resume] 解析失敗(書類なしとして続行): ${e.message}`)
    return { status: 'failed', error: e.message }
  } finally {
    // 生PDF(base64)は完了後に破棄（保存しない）
    delete criteria.resumePdfBase64
  }
}

const env = process.env
const APP_URL = env.APP_URL || 'http://localhost:3000'
const TOKEN = env.INGEST_TOKEN || ''
const POLL = parseInt(env.POLL_INTERVAL || '5000', 10)
const HEADLESS = (env.HEADLESS || 'true') === 'true'
const ONCE = process.argv.includes('--once')

// 処理対象ソース。環境変数 SOURCES（カンマ区切り）で上書き可能（テスト時に circus のみ等）。
const SOURCES = (env.SOURCES || 'circus,hitolink,jobins')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean)

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
  // 詳細ページを取得する候補数の上限（各詳細取得はページ遷移=数秒かかるので、
  // 精読対象の中でも1次スコア上位のこの件数だけ詳細取得する。コスト/時間管理の要）。
  MAX_DETAIL: parseInt(env.MAX_DETAIL || '30', 10),
  // トークン予算の上限（超えたら探索/精読を打ち切る）。
  // gpt-5-nano は安価だが100円以内を安全に守るための上限。
  TOKEN_BUDGET: parseInt(env.TOKEN_BUDGET || '400000', 10),
  // 時間上限（ミリ秒）。既定2時間。
  TIME_LIMIT_MS: parseInt(env.TIME_LIMIT_MS || String(2 * 60 * 60 * 1000), 10),
  // --- 機能A（AI条件反復検索・API直接方式）用 ---
  // 1プランあたり取得する最大求人数（API pagination の上限）。
  PLAN_MAX_FETCH: parseInt(env.PLAN_MAX_FETCH || '500', 10),
  // API 1リクエストの取得件数（circus は最大25件/リクエスト）。
  API_PAGE_SIZE: parseInt(env.API_PAGE_SIZE || '25', 10),
  // プラン件数がこの上限を超えたら「絞りすぎ緩和/追加条件」は行わず先頭から取得。
  // （ユーザ指示: 絞りすぎ禁物。広めヒットは許容し、AI採点で絞る方針）
  PLAN_COUNT_CAP: parseInt(env.PLAN_COUNT_CAP || '3000', 10),
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

  // circus は【API直接方式】で機能A(AI条件反復検索)＋機能B(詳細=mapApiJob)を実行する。
  // 対応判定: getAuthToken/apiSearch/mapApiJob を持つアダプタのみ。
  const apiCapable =
    typeof adapter.getAuthToken === 'function' &&
    typeof adapter.apiSearch === 'function' &&
    typeof adapter.mapApiJob === 'function'
  if (!apiCapable) {
    await reportState(searchJobId, source, { phase: 'error', message: `${source} は未対応（API直接方式未実装）` })
    return
  }

  const context = await browser.newContext({ viewport: { width: 1400, height: 1000 } })
  const page = await context.newPage()
  const startedAt = Date.now()
  const useAI = (criteria.freeText || '').trim().length > 0
  const topN = criteria.topN || 10

  let scanned = 0          // 収集(取得)した総求人数
  let tokens = 0           // 消費トークン累計
  const pool = []          // 精読候補プール { job, preScore, briefScore }
  const seenIds = new Set() // プラン横断の重複除去（求人ID）
  // 条件緩和レコメンド用プール:
  //   「年齢/性別/学歴（=変更不可のHIGH情報）はOKだが、
  //    年収/勤務地/雇用形態などの緩和可能条件で機械フィルタに落ちた」求人を溜める。
  //   通常マッチが topN に満たない場合に、条件を緩めて提案する候補源。
  const relaxPool = []     // { job, relaxedReasons: [落ちた条件...] }

  const timeUp = () => Date.now() - startedAt > EXPLORE.TIME_LIMIT_MS

  try {
    // ---- ログイン → 認証トークン取得（API直接方式）----
    await reportState(searchJobId, source, { phase: 'fetching', message: 'ログイン中…' })
    await adapter.login(page, env)
    await reportState(searchJobId, source, { phase: 'fetching', message: '認証トークン取得中…' })
    const token = await adapter.getAuthToken(page)
    console.log(`[${source}] 認証トークン取得OK`)

    // ---- 媒体の総求人数（未フィルタ）を取得 ----
    // フロント右上「総求人数」に表示するのは、この媒体が今この瞬間に
    // 保有している求人の総数（＝検索条件を一切かけない全件）。
    // 各プランの該当件数の合計(grandTotal)は重複で過大計上されるため使わない。
    let mediaTotal = null
    try {
      const allQJson = adapter.buildQJson({ or: '' })
      mediaTotal = await adapter.apiCount(page, token, { qJson: allQJson, filters: {} })
      console.log(`[${source}] 媒体の総求人数(未フィルタ)=${mediaTotal ?? '?'}件`)
    } catch (e) {
      console.log(`[${source}] 媒体総数取得失敗: ${e.message}`)
    }

    // ---- 添付PDF(職務経歴書/履歴書)があれば解析し criteria に反映 ----
    // 個人情報(氏名/住所等)をマスクした上で優秀モデルが要約し、検索プランに活かす。
    // PDFが無くてもそのまま続行（書類なしでも動作）。
    if (criteria.resumePdfBase64 && !criteria.resumeText) {
      await reportState(searchJobId, source, { phase: 'fetching', message: '添付書類（職務経歴書）を解析中…' })
      const rr = await ensureResumeAnalyzed(searchJobId, criteria)
      if (rr && rr.status === 'ok') {
        const jt = (rr.analysis?.jobTypes || []).slice(0, 3).join('・')
        await reportState(searchJobId, source, { phase: 'fetching', message: `書類を解析しました${jt ? `（経験職種: ${jt}）` : ''}。この経歴も踏まえて検索します。` })
      } else if (rr && rr.status === 'failed') {
        await reportState(searchJobId, source, { phase: 'fetching', message: '添付書類からテキストを抽出できませんでした（画像PDF等の可能性）。希望条件のみで検索します。' })
      }
    }

    // ---- 機能A: AIが検索プラン(複数)を生成 ----
    await reportState(searchJobId, source, { phase: 'fetching', message: 'AIが検索プランを設計中…' })
    let plans = []
    try {
      const r = await buildSearchPlans(env, criteria)
      plans = r.plans
      tokens += r.tokensUsed
    } catch (e) {
      console.log(`[${source}] buildSearchPlans失敗 → 単一フォールバックプラン: ${e.message}`)
    }
    if (!plans.length) {
      // 最終フォールバック: キーワードのみの1プラン
      plans = [{ label: 'フォールバック', keywords: [], orKeyword: adapter.extractKeyword(criteria) || '', filters: {} }]
    }
    console.log(`[${source}] 検索プラン ${plans.length}件:`)
    plans.forEach((p, i) => console.log(`  [${i}] ${p.label} kw="${p.orKeyword}" filters=${JSON.stringify(p.filters)}`))
    await reportState(searchJobId, source, {
      phase: 'fetching', tokensUsed: tokens,
      message: `AIが${plans.length}通りの検索プランを設計。反復検索を開始…`,
    })

    let grandTotal = 0 // 全プランの該当件数合計（参考表示用）

    // ---- 機能A ループ: 各プランを count→取得→機械フィルタ→1次AI粗選別 ----
    for (let pi = 0; pi < plans.length; pi++) {
      if (timeUp()) { console.log(`[${source}] プラン反復中断: 時間上限`); break }
      if (tokens >= EXPLORE.TOKEN_BUDGET) { console.log(`[${source}] プラン反復中断: トークン予算`); break }
      if (scanned >= EXPLORE.MAX_SCAN) { console.log(`[${source}] プラン反復中断: スキャン上限`); break }

      const plan = plans[pi]
      const qJson = adapter.buildQJson({ or: plan.orKeyword })

      // 件数確認（jobSearchMatches）: ユーザのFunction Aパターン
      // 「絞り込んで件数を見る→条件を少し変えて再検索」を反映。
      let planTotal = null
      try {
        planTotal = await adapter.apiCount(page, token, { qJson, filters: plan.filters })
      } catch (e) {
        console.log(`[${source}] apiCount失敗(plan ${pi}): ${e.message}`)
      }
      if (planTotal != null) grandTotal += planTotal
      console.log(`[${source}] plan[${pi}] "${plan.label}" 該当=${planTotal ?? '?'}件`)
      await reportState(searchJobId, source, {
        phase: 'fetching', scanned, candidates: pool.length, tokensUsed: tokens,
        totalInDb: mediaTotal ?? grandTotal ?? undefined,
        message: `プラン${pi + 1}/${plans.length}「${plan.label}」該当${(planTotal ?? 0).toLocaleString()}件を精査中…`,
      })

      // 該当0件ならスキップ（次プランへ）
      if (planTotal === 0) continue

      // このプランから取得する上限件数（絞りすぎ緩和はせず、上限内で収集しAI採点で絞る）
      const fetchCap = Math.min(
        EXPLORE.PLAN_MAX_FETCH,
        planTotal != null ? planTotal : EXPLORE.PLAN_MAX_FETCH,
      )

      // ページネーションで収集
      for (let offset = 0; offset < fetchCap; offset += EXPLORE.API_PAGE_SIZE) {
        if (timeUp()) { console.log(`[${source}] 取得中断: 時間上限`); break }
        if (scanned >= EXPLORE.MAX_SCAN) { console.log(`[${source}] 取得中断: スキャン上限`); break }
        if (tokens >= EXPLORE.TOKEN_BUDGET) { console.log(`[${source}] 取得中断: トークン予算`); break }

        const pageNo = Math.floor(offset / EXPLORE.API_PAGE_SIZE) + 1
        let resp
        try {
          resp = await adapter.apiSearch(page, token, {
            qJson, filters: plan.filters,
            limit: EXPLORE.API_PAGE_SIZE, offset, pageNo,
          })
        } catch (e) {
          console.log(`[${source}] apiSearch失敗(plan ${pi} off ${offset}): ${e.message}`)
          break
        }
        const rawJobs = resp.jobs || []
        if (!rawJobs.length) break // 末尾

        // 機能B: 生API job → 内部 job 形状へ変換（詳細情報込み。別途取得不要）
        const jobs = rawJobs.map((rj) => adapter.mapApiJob(rj)).filter(Boolean)

        // プラン横断の重複除去
        const fresh = []
        for (const job of jobs) {
          const id = `${source}:${job.sourceJobId}`
          if (job.sourceJobId && seenIds.has(id)) continue
          if (job.sourceJobId) seenIds.add(id)
          fresh.push(job)
        }
        scanned += fresh.length
        if (!fresh.length) continue

        // 機械フィルタ（勤務地/年収/雇用=hardFail、職種/業種=加点のみ）
        // + 揺るぎないHIGH情報(年齢/性別/学歴)による除外（API方式では最初から判定可能）
        const survivors = []
        for (const job of fresh) {
          const dv = evaluateDetail(job, criteria)
          // 年齢/性別/学歴（=変更不可）のミスマッチは常に即除外（緩和対象にもしない）
          if (dv.hardFail) continue
          const ev = evaluateOne(job, criteria)
          if (ev.hardFail) {
            // 年収/勤務地/雇用など「緩和可能条件」で落ちた求人は
            // 件数不足時のレコメンド候補として保持（年齢/性別/学歴はクリア済み）。
            if (relaxPool.length < 400) relaxPool.push({ job, relaxedReasons: ev.reasons || [] })
            continue
          }
          survivors.push(ev)
        }

        // 1次AI粗選別（安く大量に） or 機械スコア候補化
        if (survivors.length) {
          if (!useAI) {
            for (const ev of survivors) {
              if (ev.preScore >= EXPLORE.BRIEF_THRESHOLD) {
                pool.push({ job: ev.job, preScore: ev.preScore, briefScore: ev.preScore })
              }
            }
          } else {
            for (let i = 0; i < survivors.length; i += EXPLORE.BRIEF_BATCH) {
              if (tokens >= EXPLORE.TOKEN_BUDGET) break
              const chunk = survivors.slice(i, i + EXPLORE.BRIEF_BATCH)
              const { results, tokensUsed } = await scoreBriefBatch(env, criteria, chunk.map((s) => s.job))
              tokens += tokensUsed
              for (const r of results) {
                if (r.score >= EXPLORE.BRIEF_THRESHOLD) {
                  pool.push({ job: chunk[r.index].job, preScore: chunk[r.index].preScore, briefScore: r.score })
                }
              }
            }
          }
        }

        console.log(`[${source}] plan[${pi}] off${offset}: 取得${rawJobs.length} 新規${fresh.length}(計${scanned}) 通過${survivors.length} 候補計${pool.length} tok${tokens}`)
        await reportState(searchJobId, source, {
          phase: 'fetching', scanned, candidates: pool.length, tokensUsed: tokens,
          totalInDb: mediaTotal ?? grandTotal ?? undefined,
          message: `プラン${pi + 1}/${plans.length}「${plan.label}」${scanned.toLocaleString()}件走査 / 有望候補${pool.length}件`,
        })
      } // offset loop
    } // plan loop

    // ---- 2次精読フェーズ ----
    // プールを1次スコア順に並べ、上位 MAX_DEEP 件だけ全文精読する。
    // 機能Bはすでに完了（mapApiJob が詳細情報を保持）なので詳細ページ取得は不要。
    pool.sort((a, b) => b.briefScore - a.briefScore)
    const scoreTargets = pool.slice(0, EXPLORE.MAX_DEEP)
    console.log(`[${source}] 反復検索完了: 走査${scanned} / 有望候補${pool.length} / 精読対象${scoreTargets.length}`)

    await reportState(searchJobId, source, {
      phase: 'scoring', scanned, candidates: pool.length, tokensUsed: tokens,
      message: `上位${scoreTargets.length}件を精読中…`,
    })

    let matched = 0
    const finalMatches = []
    if (!useAI) {
      for (const c of scoreTargets) finalMatches.push({ job: c.job, score: c.preScore, reason: '条件一致(機械評価)' })
    } else {
      for (let i = 0; i < scoreTargets.length; i += EXPLORE.DEEP_BATCH) {
        if (tokens >= EXPLORE.TOKEN_BUDGET) { console.log(`[${source}] 精読中断: トークン予算`); break }
        const batch = scoreTargets.slice(i, i + EXPLORE.DEEP_BATCH).map((c) => c.job)
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
    const pushedIds = new Set()
    for (const m of finalMatches.slice(0, topN)) {
      await pushResult(searchJobId, m.job, m.score, m.reason)
      if (m.job.sourceJobId) pushedIds.add(String(m.job.sourceJobId))
      matched++
    }

    // ---- 件数不足時: 条件緩和レコメンド ----
    // 通常マッチが払い出し件数(topN)に満たない場合、
    // 年齢/性別/学歴は変更せず、緩和可能条件(年収/勤務地/雇用形態など)を
    // 緩めれば提案できる求人を、AIに理由付き(300字)で推薦させて補充する。
    const shortfall = topN - matched
    if (shortfall > 0 && useAI && relaxPool.length && tokens < EXPLORE.TOKEN_BUDGET) {
      console.log(`[${source}] 通常${matched}件 < 希望${topN}件 → 条件緩和レコメンド開始 (候補${relaxPool.length}件)`)
      await reportState(searchJobId, source, {
        phase: 'scoring', scanned, candidates: pool.length, tokensUsed: tokens,
        message: `希望${topN}件に対し${matched}件のみ合致。条件を緩めた提案を検討中…`,
      })
      // 既に払い出した求人は除外し、重複IDも除く
      const seenRelax = new Set()
      const relaxTargets = []
      for (const e of relaxPool) {
        const id = e.job.sourceJobId ? String(e.job.sourceJobId) : null
        if (id && (pushedIds.has(id) || seenRelax.has(id))) continue
        if (id) seenRelax.add(id)
        relaxTargets.push(e)
      }
      // コスト管理: 精査するのは不足数の数倍まで（最大 shortfall*4, 上限40件）
      const relaxCap = Math.min(relaxTargets.length, Math.max(shortfall * 4, 12), 40)
      const relaxSlice = relaxTargets.slice(0, relaxCap)
      const relaxMatches = []
      for (let i = 0; i < relaxSlice.length; i += EXPLORE.DEEP_BATCH) {
        if (tokens >= EXPLORE.TOKEN_BUDGET) break
        const batch = relaxSlice.slice(i, i + EXPLORE.DEEP_BATCH)
        try {
          const { results, tokensUsed } = await scoreRelaxBatch(env, criteria, batch)
          tokens += tokensUsed
          for (const r of results) {
            if (r.score >= EXPLORE.DEEP_THRESHOLD - 10) { // 緩和枠は閾値を少し下げる
              relaxMatches.push({ entry: batch[r.index], score: r.score, reason: r.reason })
            }
          }
        } catch (e) {
          console.log(`[${source}] scoreRelaxBatch失敗: ${e.message}`)
        }
      }
      relaxMatches.sort((a, b) => b.score - a.score)
      for (const rm of relaxMatches.slice(0, shortfall)) {
        // job に緩和レコメンドの目印を付けて払い出す（フロントで別扱い/バッジ表示）
        const job = {
          ...rm.entry.job,
          isRecommend: true,
          relaxedReasons: rm.entry.relaxedReasons || [],
        }
        await pushResult(searchJobId, job, rm.score, rm.reason)
        matched++
      }
      console.log(`[${source}] 条件緩和レコメンド: ${relaxMatches.slice(0, shortfall).length}件を追加提案`)
    }

    await reportState(searchJobId, source, {
      phase: 'done', matched, tokensUsed: tokens,
      totalInDb: mediaTotal ?? grandTotal ?? scanned, scanned,
      candidates: pool.length,
      message: `完了: 媒体総求人${(mediaTotal ?? scanned).toLocaleString()}件 / 該当延べ${(grandTotal || scanned).toLocaleString()}件を走査→${pool.length}件精査→${matched}件を提案 (トークン約${tokens})`,
    })
  } catch (e) {
    console.error(`[${source}] error:`, e)
    // エラーは切り詰めず全文を message に入れる（UI側で全文コピー可能にするため）。
    // stack があれば併記して原因追跡をしやすくする。
    const full = e && e.stack ? String(e.stack) : String(e && e.message ? e.message : e)
    await reportState(searchJobId, source, { phase: 'error', message: `エラー: ${full}` })
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
