// 検索オーケストレーター
// 各DB担当(worker)を動かし、記憶チェック→取得→機械フィルタ→AI採点→逐次払い出し
// を実行する。Cloudflareのバックグラウンド実行(waitUntil)で走らせる。

import type { SearchCriteria, SourceId, NormalizedJob } from './types'
import { fetchKintoneJobs, type KintoneConfig } from './kintone'
import { mechanicalFilter } from './filter'
import { scoreBatch, type ScorerConfig } from './scorer'
import {
  upsertJobsBatch,
  getCachedJobs,
  updateWorkerState,
  pushResult,
  rememberScore,
  recallScores,
  type D1,
} from './db'

// 検索条件を正規化してハッシュ化（記憶のキー）
// フリー記述はキャッシュのブレを避けるため小文字・空白除去した先頭120文字を採用
export async function criteriaHash(c: SearchCriteria): Promise<string> {
  const norm = {
    f: c.freeText.toLowerCase().replace(/\s+/g, '').slice(0, 120),
    r: c.requirements.toLowerCase().replace(/\s+/g, '').slice(0, 60),
    l: [...c.locations].sort(),
    sMin: c.salaryMin,
    emp: [...c.employment].sort(),
    jc: [...c.jobCategories].sort(),
    ind: [...c.industries].sort(),
    ot: c.overtimeMax,
    hol: [...c.holiday].sort(),
  }
  const str = JSON.stringify(norm)
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(str))
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
    .slice(0, 32)
}

export interface Env {
  DB: D1
  OPENAI_API_KEY: string
  OPENAI_BASE_URL: string
  OPENAI_MODEL: string
  KINTONE_SUBDOMAIN: string
  KINTONE_APP_ID: string
  KINTONE_API_TOKEN: string
}

// AIに投げるバッチサイズ（トークンと精度のバランス）
const AI_BATCH_SIZE = 10
// AI採点する最大候補数（機械フィルタ後の上位のみ採点してトークン節約）
const MAX_AI_CANDIDATES = 40
// マッチとみなす最低スコア
const MATCH_THRESHOLD = 55

// kintone担当ワーカー
async function runKintoneWorker(
  env: Env,
  searchJobId: string,
  criteria: SearchCriteria,
  cHash: string
): Promise<void> {
  const source: SourceId = 'kintone'
  const scorer: ScorerConfig = {
    apiKey: env.OPENAI_API_KEY,
    baseUrl: env.OPENAI_BASE_URL,
    model: env.OPENAI_MODEL || 'gpt-5-nano',
  }
  const kcfg: KintoneConfig = {
    subdomain: env.KINTONE_SUBDOMAIN,
    appId: env.KINTONE_APP_ID,
    apiToken: env.KINTONE_API_TOKEN,
  }

  try {
    // === フェーズ1: 記憶チェック ===
    await updateWorkerState(env.DB, searchJobId, source, {
      phase: 'fetching',
      message: '記憶(キャッシュ)を確認中…',
    })

    const cached = await getCachedJobs(env.DB, source, true)
    let jobs: NormalizedJob[] = []
    let fromMemoryCount = 0

    if (cached.length > 0) {
      // 記憶がある → まず記憶から機械フィルタして即・仮払い出し用に使う
      jobs = cached
      await updateWorkerState(env.DB, searchJobId, source, {
        message: `記憶から${cached.length}件を確認。最新データを取得中…`,
        from_memory: cached.length,
      })
    }

    // === フェーズ2: 最新データを取得（記憶を更新） ===
    await updateWorkerState(env.DB, searchJobId, source, {
      phase: 'fetching',
      message: 'kintoneから最新求人を取得中…',
    })
    let fresh: NormalizedJob[] = []
    try {
      fresh = await fetchKintoneJobs(kcfg, { onlyOpen: true })
      // 記憶を更新（次回の高速提案のため）
      if (fresh.length > 0) {
        await upsertJobsBatch(env.DB, fresh)
      }
      jobs = fresh // 最新を優先
    } catch (e: any) {
      // 取得失敗時は記憶で代替
      if (jobs.length === 0) throw e
      await updateWorkerState(env.DB, searchJobId, source, {
        message: `取得失敗のため記憶(${jobs.length}件)で検索します`,
      })
    }

    const totalInDb = jobs.length
    await updateWorkerState(env.DB, searchJobId, source, {
      scanned: totalInDb,
      total_in_db: totalInDb,
    })

    // === フェーズ3: 機械フィルタ（トークン消費ゼロ） ===
    await updateWorkerState(env.DB, searchJobId, source, {
      phase: 'filtering',
      message: `${totalInDb}件を条件で絞り込み中…`,
    })
    const filtered = mechanicalFilter(jobs, criteria)
    await updateWorkerState(env.DB, searchJobId, source, {
      candidates: filtered.length,
      message: `条件通過 ${filtered.length}件。AIで一致度を評価します`,
    })

    // フリー記述が無い場合はAIを呼ばず preScore で払い出し（トークン節約）
    const useAI = criteria.freeText.trim().length > 0 || criteria.requirements.trim().length > 0

    let matched = 0
    let tokensTotal = 0

    if (!useAI) {
      // preScoreベースで払い出し
      const sorted = filtered.sort((a, b) => b.preScore - a.preScore)
      for (const f of sorted.slice(0, criteria.topN)) {
        if (f.preScore >= MATCH_THRESHOLD || matched < criteria.topN) {
          await pushResult(env.DB, searchJobId, f.job, f.preScore, '条件一致(機械評価)', false)
          matched++
          await updateWorkerState(env.DB, searchJobId, source, { matched })
        }
      }
      await updateWorkerState(env.DB, searchJobId, source, {
        phase: 'done',
        message: `完了: ${matched}件を提案(AI未使用/トークン節約)`,
        matched,
      })
      return
    }

    // === フェーズ4: AI採点（上位候補のみ・バッチ処理・逐次払い出し） ===
    await updateWorkerState(env.DB, searchJobId, source, {
      phase: 'scoring',
      message: 'AIが一致度を採点中…',
    })

    let candidates = filtered.slice(0, MAX_AI_CANDIDATES)

    // --- 記憶からの先行払い出し（トークン消費ゼロ・即提案） ---
    // 同じ要望で過去に採点済みかつ現在も公開中の求人は、AIを呼ばずすぐ出す。
    let memoryHits = 0
    const recalled = await recallScores(env.DB, cHash, source)
    if (Object.keys(recalled).length > 0) {
      const stillToScore: typeof candidates = []
      // 記憶ヒットをスコア順に先行払い出し
      const memMatched = candidates
        .map((f) => ({ f, mem: recalled[f.job.sourceJobId] }))
        .filter((x) => x.mem && x.mem.score >= MATCH_THRESHOLD)
        .sort((a, b) => b.mem!.score - a.mem!.score)

      for (const { f, mem } of memMatched) {
        if (matched >= criteria.topN) break
        await pushResult(env.DB, searchJobId, f.job, mem!.score, mem!.reason || '記憶から即提案', true)
        matched++
        memoryHits++
      }
      // まだ採点していない求人だけを残す（記憶にない or マッチ未満だったもの）
      for (const f of candidates) {
        if (!recalled[f.job.sourceJobId]) stillToScore.push(f)
      }
      candidates = stillToScore

      if (memoryHits > 0) {
        await updateWorkerState(env.DB, searchJobId, source, {
          matched,
          from_memory: memoryHits,
          message: `記憶から${memoryHits}件を即提案。残りをAI採点します`,
        })
      }
    }

    for (let i = 0; i < candidates.length; i += AI_BATCH_SIZE) {
      // 十分な件数が見つかったら早期終了（トークン節約）
      if (matched >= criteria.topN) {
        await updateWorkerState(env.DB, searchJobId, source, {
          message: `${criteria.topN}件確保のため採点を早期終了(トークン節約)`,
        })
        break
      }

      const batch = candidates.slice(i, i + AI_BATCH_SIZE)
      const batchJobs = batch.map((b) => b.job)
      const { results, tokensUsed } = await scoreBatch(scorer, criteria, batchJobs)
      tokensTotal += tokensUsed

      // スコアの高い順に払い出し
      const scored = results
        .map((r) => ({ job: batchJobs[r.index], score: r.score, reason: r.reason }))
        .sort((a, b) => b.score - a.score)

      for (const s of scored) {
        // 採点結果を記憶（次回の高速提案用）
        await rememberScore(env.DB, cHash, source, s.job.sourceJobId, s.score, s.reason)
        if (s.score >= MATCH_THRESHOLD) {
          await pushResult(env.DB, searchJobId, s.job, s.score, s.reason, false)
          matched++
        }
      }

      await updateWorkerState(env.DB, searchJobId, source, {
        matched,
        tokens_used: tokensTotal,
        message: `採点中… ${Math.min(i + AI_BATCH_SIZE, candidates.length)}/${candidates.length}件評価 (${matched}件マッチ)`,
      })
    }

    await updateWorkerState(env.DB, searchJobId, source, {
      phase: 'done',
      message: `完了: ${matched}件を提案${memoryHits ? `(内${memoryHits}件は記憶から)` : ''} (消費トークン約${tokensTotal})`,
      matched,
      from_memory: memoryHits,
      tokens_used: tokensTotal,
    })
  } catch (e: any) {
    await updateWorkerState(env.DB, searchJobId, source, {
      phase: 'error',
      message: `エラー: ${String(e.message || e).slice(0, 200)}`,
    })
  }
}

// スクレイピング系DB担当（手元PC/VPSの外部ワーカーが担当）
// phase='skipped' は「外部ワーカーの取り込み待ち」を表す。
// 外部ワーカーが /api/ingest/pending でこのジョブを拾い、
// /api/ingest/state で phase を更新していく。
async function runExternalWorkerQueued(
  env: Env,
  searchJobId: string,
  source: SourceId
): Promise<void> {
  await updateWorkerState(env.DB, searchJobId, source, {
    phase: 'skipped',
    message: '担当を割り当て中（外部ワーカーの応答待ち）…',
  })
}

// 外部ワーカーが担当するソース
const EXTERNAL_SOURCES: SourceId[] = ['circus', 'hitolink', 'jobins']

// メインオーケストレーション
export async function runSearch(
  env: Env,
  searchJobId: string,
  criteria: SearchCriteria
): Promise<void> {
  const workers: Promise<void>[] = []
  const cHash = await criteriaHash(criteria)

  // 各担当を初期化
  for (const src of criteria.sources) {
    await updateWorkerState(env.DB, searchJobId, src, {
      phase: 'idle',
      message: '待機中…',
    })
  }

  // 並列でワーカー起動
  const hasExternal = criteria.sources.some((s) => EXTERNAL_SOURCES.includes(s))
  for (const src of criteria.sources) {
    if (src === 'kintone') {
      workers.push(runKintoneWorker(env, searchJobId, criteria, cHash))
    } else {
      // 外部ワーカー(手元PC/VPS)の取り込み待ちキューに入れる
      workers.push(runExternalWorkerQueued(env, searchJobId, src))
    }
  }

  await Promise.allSettled(workers)

  // 集計（現時点の途中経過）
  await refreshSearchTotals(env.DB, searchJobId)

  // 外部ソースが無い（内部処理のみ）ならここで完了。
  // 外部ソースがある場合はジョブを running のまま維持し、
  // 外部ワーカーの完了報告(/api/ingest/state phase=done)で完了させる。
  if (!hasExternal) {
    await env.DB.prepare(
      `UPDATE search_jobs SET status='done', finished_at=datetime('now') WHERE id=?`
    )
      .bind(searchJobId)
      .run()
  }
}

// worker_states を集計して search_jobs の合計を更新する
export async function refreshSearchTotals(db: D1, searchJobId: string): Promise<void> {
  const totals: any = await db
    .prepare(
      `SELECT COALESCE(SUM(scanned),0) as scanned, COALESCE(SUM(matched),0) as matched FROM worker_states WHERE search_job_id=?`
    )
    .bind(searchJobId)
    .first()
  await db
    .prepare(`UPDATE search_jobs SET total_scanned=?, total_matched=? WHERE id=?`)
    .bind(totals?.scanned ?? 0, totals?.matched ?? 0, searchJobId)
    .run()
}

// 全ソースがdone/errorに達していれば search_jobs を完了させる
export async function maybeCompleteSearch(db: D1, searchJobId: string): Promise<boolean> {
  const job: any = await db
    .prepare(`SELECT criteria_json, status FROM search_jobs WHERE id=?`)
    .bind(searchJobId)
    .first()
  if (!job || job.status === 'done') return job?.status === 'done'
  const criteria = JSON.parse(job.criteria_json) as SearchCriteria
  const states: any = await db
    .prepare(`SELECT source, phase FROM worker_states WHERE search_job_id=?`)
    .bind(searchJobId)
    .all()
  const rows = states.results || []
  const done = criteria.sources.every((src) => {
    const st = rows.find((r: any) => r.source === src)
    return st && (st.phase === 'done' || st.phase === 'error')
  })
  if (done) {
    await refreshSearchTotals(db, searchJobId)
    // 添付書類(PDF)の破棄: 検索完了後、criteria_json から生PDF(base64)を除去する。
    // ユーザー方針「書類は完了後に破棄」を満たすため、DB上にも残さない。
    let cleanedCriteriaJson = job.criteria_json
    if (criteria.resumePdfBase64) {
      delete (criteria as any).resumePdfBase64
      cleanedCriteriaJson = JSON.stringify(criteria)
    }
    await db
      .prepare(`UPDATE search_jobs SET status='done', finished_at=datetime('now'), criteria_json=? WHERE id=?`)
      .bind(cleanedCriteriaJson, searchJobId)
      .run()
  }
  return done
}
