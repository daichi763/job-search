import { Hono } from 'hono'
import { cors } from 'hono/cors'
import type { Env } from './lib/orchestrator'
import { runSearch, maybeCompleteSearch, refreshSearchTotals } from './lib/orchestrator'
import { fetchKintoneCount } from './lib/kintone'
import type { SearchCriteria, SourceId } from './lib/types'
import { SOURCE_LABELS } from './lib/types'
import { renderPage } from './ui'
import { renderManualPage } from './ui_manual'

type Bindings = Env

const app = new Hono<{ Bindings: Bindings }>()

app.use('/api/*', cors())

// UUID生成
function uuid(): string {
  return crypto.randomUUID()
}

// 検索条件を短い日本語サマリに整形（履歴一覧の表示用）
function summarizeCriteria(criteria: any): string {
  if (!criteria || typeof criteria !== 'object') return ''
  const parts: string[] = []
  if (Array.isArray(criteria.jobCategories) && criteria.jobCategories.length) {
    parts.push(`職種:${criteria.jobCategories.slice(0, 3).join('・')}`)
  }
  if (Array.isArray(criteria.locations) && criteria.locations.length) {
    parts.push(`勤務地:${criteria.locations.slice(0, 3).join('・')}`)
  }
  if (criteria.salaryMin != null || criteria.salaryMax != null) {
    const lo = criteria.salaryMin != null ? `${criteria.salaryMin}万` : ''
    const hi = criteria.salaryMax != null ? `${criteria.salaryMax}万` : ''
    parts.push(`年収:${lo}〜${hi}`)
  }
  if (Array.isArray(criteria.employment) && criteria.employment.length) {
    parts.push(`雇用:${criteria.employment.slice(0, 2).join('・')}`)
  }
  if (criteria.age) parts.push(`年齢:${criteria.age}`)
  if (criteria.gender) parts.push(`性別:${criteria.gender}`)
  if (criteria.education) parts.push(`学歴:${criteria.education}`)
  return parts.join(' / ')
}

// ---------------------------------------------------------
// 検索開始
// ---------------------------------------------------------
// 「進行中」とみなす閾値（分）。これより古い running はハングとみなし新規検索を許可する。
const RUNNING_STALE_MINUTES = 30
// 担当(worker_states)が途中状態のままこの分数以上更新されなければ「ハング」とみなす。
//   ・pending で再取得してworkerに再割り当て（対策1）
//   ・maybeCompleteSearch でerror扱いにして検索を強制完了（対策2）
const STALE_PICKUP_MINUTES = 10

app.post('/api/search', async (c) => {
  // --- 同時実行ガード：サーバー負荷軽減のため、実行中の検索が1つでもあれば新規検索を拒否 ---
  const active: any = await c.env.DB.prepare(
    `SELECT id, free_text, created_at FROM search_jobs
     WHERE status='running'
       AND created_at > datetime('now', ?)
     ORDER BY created_at DESC LIMIT 1`
  )
    .bind(`-${RUNNING_STALE_MINUTES} minutes`)
    .first()
  if (active) {
    return c.json({
      error: 'search_in_progress',
      message: '現在ほかの検索を実行中です。完了までお待ちください。',
      activeSearchJobId: active.id,
      activeFreeText: active.free_text || '',
      activeCreatedAt: active.created_at,
    }, 409)
  }

  const body = await c.req.json<Partial<SearchCriteria>>()

  const criteria: SearchCriteria = {
    freeText: body.freeText || '',
    locations: body.locations || [],
    salaryMin: body.salaryMin ?? null,
    salaryMax: body.salaryMax ?? null,
    employment: body.employment || [],
    jobCategories: body.jobCategories || [],
    industries: body.industries || [],
    overtimeMax: body.overtimeMax || '',
    holiday: body.holiday || [],
    benefits: body.benefits || [],
    requirements: body.requirements || '',
    // 応募条件（HIGH優先）
    age: body.age != null && `${body.age}` !== '' ? Number(body.age) : null,
    gender: body.gender || '',
    education: body.education || '',
    topN: Math.max(1, Math.min(50, body.topN || 10)),
    sources: body.sources && body.sources.length ? body.sources : ['kintone', 'circus', 'hitolink', 'jobins'],
    // 添付書類(PDF)。base64のまま criteria_json に一時保存し、worker が解析後に破棄する。
    // 未添付なら undefined のまま（書類なしでも動作）。
    resumePdfBase64: typeof body.resumePdfBase64 === 'string' && body.resumePdfBase64.length > 0
      ? body.resumePdfBase64
      : undefined,
  }

  const searchJobId = uuid()
  await c.env.DB.prepare(
    `INSERT INTO search_jobs (id, criteria_json, free_text, top_n, status) VALUES (?,?,?,?,'running')`
  )
    .bind(searchJobId, JSON.stringify(criteria), criteria.freeText, criteria.topN)
    .run()

  // バックグラウンドで検索実行（レスポンスは即返す）
  const runner = runSearch(c.env, searchJobId, criteria)
  // @ts-ignore executionCtx
  if (c.executionCtx && c.executionCtx.waitUntil) {
    c.executionCtx.waitUntil(runner)
  } else {
    // devローカルなどで waitUntil が無い場合
    runner.catch(() => {})
  }

  return c.json({ searchJobId })
})

// ---------------------------------------------------------
// 実行中の検索があるか（ページ表示時の復帰・ボタン制御に使用）
// 静的パスなので :id ルートより前に定義すること
// ---------------------------------------------------------
app.get('/api/search/active', async (c) => {
  // 実行中とされている全ジョブについて、ハング担当の救済＆完了判定を試みる。
  // （全ソースが無応答で /api/ingest/state が来なくなっても、ここで running を回収できる）
  const { results: runningJobs } = await c.env.DB.prepare(
    `SELECT id FROM search_jobs WHERE status='running'`
  ).all()
  for (const r of (runningJobs || []) as any[]) {
    try { await maybeCompleteSearch(c.env.DB, r.id) } catch (_) {}
  }

  const active: any = await c.env.DB.prepare(
    `SELECT id, free_text, created_at, total_scanned, total_matched FROM search_jobs
     WHERE status='running'
       AND created_at > datetime('now', ?)
     ORDER BY created_at DESC LIMIT 1`
  )
    .bind(`-${RUNNING_STALE_MINUTES} minutes`)
    .first()
  if (!active) return c.json({ active: false })
  return c.json({
    active: true,
    searchJobId: active.id,
    freeText: active.free_text || '',
    createdAt: active.created_at,
    totalScanned: active.total_scanned,
    totalMatched: active.total_matched,
  })
})

// ---------------------------------------------------------
// 進捗（AI担当状態）取得
// ---------------------------------------------------------
app.get('/api/search/:id/status', async (c) => {
  const id = c.req.param('id')
  const job: any = await c.env.DB.prepare(`SELECT * FROM search_jobs WHERE id=?`).bind(id).first()
  if (!job) return c.json({ error: 'not found' }, 404)

  const { results: workers } = await c.env.DB.prepare(
    `SELECT * FROM worker_states WHERE search_job_id=? ORDER BY source`
  )
    .bind(id)
    .all()

  return c.json({
    status: job.status,
    totalScanned: job.total_scanned,
    totalMatched: job.total_matched,
    workers: (workers || []).map((w: any) => ({
      source: w.source,
      label: SOURCE_LABELS[w.source as SourceId] || w.source,
      phase: w.phase,
      message: w.message,
      scanned: w.scanned,
      candidates: w.candidates,
      matched: w.matched,
      fromMemory: w.from_memory,
      tokensUsed: w.tokens_used,
      totalInDb: w.total_in_db,
    })),
  })
})

// ---------------------------------------------------------
// 検索の中止（フロントの「検索を中止」ボタン）
//   search_jobs.status を 'cancelled' にする。
//   ・pending から外れるので、まだ処理を始めていないソースは着手されない。
//   ・処理中のワーカーは cancel をポーリング(/api/ingest/cancelled)して中断し、
//     それまでに見つけた部分結果を確定して done を報告する。
// ---------------------------------------------------------
app.post('/api/search/:id/cancel', async (c) => {
  const id = c.req.param('id')
  const job: any = await c.env.DB.prepare(`SELECT id, status FROM search_jobs WHERE id=?`).bind(id).first()
  if (!job) return c.json({ error: 'not found' }, 404)
  if (job.status !== 'running') {
    return c.json({ ok: true, status: job.status, message: 'すでに終了しています' })
  }

  // ジョブを中止扱いに。まだ着手していない(skipped)ワーカーは即座に取り込み対象外へ。
  await c.env.DB.prepare(
    `UPDATE search_jobs SET status='cancelled', finished_at=datetime('now') WHERE id=? AND status='running'`
  ).bind(id).run()

  // まだ処理を始めていない(skipped)ソースは、この時点で cancelled 表示にしておく。
  await c.env.DB.prepare(
    `UPDATE worker_states
     SET phase='cancelled', message='検索が中止されました', updated_at=datetime('now')
     WHERE search_job_id=? AND phase='skipped'`
  ).bind(id).run()

  return c.json({ ok: true, status: 'cancelled' })
})

// ---------------------------------------------------------
// 検索結果取得（逐次払い出し: since で新着のみ）
// ---------------------------------------------------------
app.get('/api/search/:id/results', async (c) => {
  const id = c.req.param('id')
  const since = parseInt(c.req.query('since') || '0', 10)

  const { results } = await c.env.DB.prepare(
    `SELECT * FROM search_results WHERE search_job_id=? AND id > ? ORDER BY score DESC, id ASC`
  )
    .bind(id, since)
    .all()

  const items = (results || []).map((r: any) => {
    let job: any = {}
    try {
      job = JSON.parse(r.job_json)
    } catch {}
    return {
      resultId: r.id,
      source: r.source,
      sourceLabel: SOURCE_LABELS[r.source as SourceId] || r.source,
      score: r.score,
      reason: r.reason,
      fromMemory: r.from_memory === 1,
      job,
    }
  })

  const maxId = items.reduce((m, it) => Math.max(m, it.resultId), since)
  return c.json({ items, maxId })
})

// ---------------------------------------------------------
// 検索履歴：一覧
//   過去の検索(search_jobs)を新しい順に返す。条件の要約と件数付き。
//   ?limit=50&offset=0 でページング可能。
// ---------------------------------------------------------
app.get('/api/history', async (c) => {
  const limit = Math.max(1, Math.min(200, parseInt(c.req.query('limit') || '50', 10)))
  const offset = Math.max(0, parseInt(c.req.query('offset') || '0', 10))

  const { results } = await c.env.DB.prepare(
    `SELECT id, criteria_json, free_text, top_n, status, created_at, finished_at,
            total_scanned, total_matched
       FROM search_jobs
      ORDER BY created_at DESC, id DESC
      LIMIT ? OFFSET ?`
  ).bind(limit, offset).all()

  const totalRow: any = await c.env.DB.prepare(`SELECT COUNT(*) AS cnt FROM search_jobs`).first()

  const items = (results || []).map((r: any) => {
    let criteria: any = {}
    try { criteria = JSON.parse(r.criteria_json) } catch {}
    // 一時保存のPDF(base64)は要約に含めない
    if (criteria && criteria.resumePdfBase64) delete criteria.resumePdfBase64
    return {
      id: r.id,
      status: r.status,
      createdAt: r.created_at,
      finishedAt: r.finished_at,
      totalScanned: r.total_scanned,
      totalMatched: r.total_matched,
      freeText: r.free_text || '',
      summary: summarizeCriteria(criteria),
      sources: (criteria.sources || []).map((s: string) => SOURCE_LABELS[s as SourceId] || s),
    }
  })

  return c.json({ items, total: totalRow?.cnt ?? items.length, limit, offset })
})

// ---------------------------------------------------------
// 検索履歴：詳細（条件 + 保存済み結果すべて）
// ---------------------------------------------------------
app.get('/api/history/:id', async (c) => {
  const id = c.req.param('id')
  const job: any = await c.env.DB.prepare(
    `SELECT id, criteria_json, free_text, top_n, status, created_at, finished_at,
            total_scanned, total_matched
       FROM search_jobs WHERE id=?`
  ).bind(id).first()
  if (!job) return c.json({ error: 'not found' }, 404)

  let criteria: any = {}
  try { criteria = JSON.parse(job.criteria_json) } catch {}
  if (criteria && criteria.resumePdfBase64) delete criteria.resumePdfBase64

  const { results } = await c.env.DB.prepare(
    `SELECT * FROM search_results WHERE search_job_id=? ORDER BY score DESC, id ASC`
  ).bind(id).all()

  const items = (results || []).map((r: any) => {
    let jobObj: any = {}
    try { jobObj = JSON.parse(r.job_json) } catch {}
    return {
      resultId: r.id,
      source: r.source,
      sourceLabel: SOURCE_LABELS[r.source as SourceId] || r.source,
      score: r.score,
      reason: r.reason,
      fromMemory: r.from_memory === 1,
      job: jobObj,
    }
  })

  return c.json({
    id: job.id,
    status: job.status,
    createdAt: job.created_at,
    finishedAt: job.finished_at,
    totalScanned: job.total_scanned,
    totalMatched: job.total_matched,
    freeText: job.free_text || '',
    criteria,
    summary: summarizeCriteria(criteria),
    sources: (criteria.sources || []).map((s: string) => SOURCE_LABELS[s as SourceId] || s),
    items,
  })
})

// ---------------------------------------------------------
// 各DBの総求人数
// ---------------------------------------------------------
app.get('/api/stats', async (c) => {
  const stats: Record<string, any> = {}

  // kintone: ライブでカウント
  let kintoneTotal = 0
  try {
    kintoneTotal = await fetchKintoneCount({
      subdomain: c.env.KINTONE_SUBDOMAIN,
      appId: c.env.KINTONE_APP_ID,
      apiToken: c.env.KINTONE_API_TOKEN,
    })
  } catch {}

  // キャッシュ件数
  const { results: cacheRows } = await c.env.DB.prepare(
    `SELECT source, COUNT(*) as cnt, SUM(is_open) as open_cnt FROM jobs GROUP BY source`
  ).all()
  const cacheMap: Record<string, any> = {}
  for (const r of cacheRows || []) {
    cacheMap[(r as any).source] = { cached: (r as any).cnt, open: (r as any).open_cnt }
  }

  // 媒体ごとの「最終検索時の総求人数」（外部ワーカーが検索完了時に報告した値）
  const { results: totalRows } = await c.env.DB.prepare(
    `SELECT source, total, updated_at FROM source_totals`
  ).all()
  const totalMap: Record<string, any> = {}
  for (const r of totalRows || []) {
    totalMap[(r as any).source] = { total: (r as any).total, updatedAt: (r as any).updated_at }
  }

  const sources: SourceId[] = ['kintone', 'circus', 'hitolink', 'jobins']
  for (const s of sources) {
    // 総求人数の優先順位:
    //   kintone → ライブカウント
    //   その他  → 最終検索時の総求人数(source_totals) → 無ければキャッシュ件数
    const lastTotal = totalMap[s]?.total ?? null
    const total = s === 'kintone'
      ? kintoneTotal
      : (lastTotal != null ? lastTotal : (cacheMap[s]?.cached ?? 0))
    stats[s] = {
      label: SOURCE_LABELS[s],
      total,
      lastSearchedTotal: lastTotal,          // 最終検索時の総求人数(null=未検索)
      lastSearchedAt: totalMap[s]?.updatedAt ?? null,
      cached: cacheMap[s]?.cached ?? 0,
      openCached: cacheMap[s]?.open ?? 0,
      connected: s === 'kintone' || s === 'circus' || s === 'hitolink' || s === 'jobins', // 全4媒体 接続済み
    }
  }

  const grandTotal = sources.reduce((sum, s) => sum + stats[s].total, 0)
  return c.json({ sources: stats, grandTotal })
})

// ---------------------------------------------------------
// 外部ワーカー(手元PC/VPS)向け 取り込みAPI
//   ①②③のスクレイピング結果をここへPOSTする。
//   簡易トークン(INGEST_TOKEN)で保護。
// ---------------------------------------------------------

// 現在running中の検索ジョブと条件を取得（外部ワーカーが検索条件を知るため）
// 管理: 詰まった running を強制回収する。
//   ・途中状態のままの担当を error にし、全ジョブの完了判定を実行。
//   ・?force=1 で「running のまま残る全ジョブ」を経過時間に関わらず即 error 完了。
// 認証は INGEST_TOKEN を流用（X-Ingest-Token ヘッダ or ?token=）。
app.post('/api/admin/reset-stale', async (c) => {
  const token = c.req.header('X-Ingest-Token') || c.req.query('token')
  if (token !== (c.env as any).INGEST_TOKEN) return c.json({ error: 'unauthorized' }, 401)
  const force = c.req.query('force') === '1'

  const { results: runningJobs } = await c.env.DB.prepare(
    `SELECT id FROM search_jobs WHERE status='running'`
  ).all()
  const ids = (runningJobs || []).map((r: any) => r.id)

  let recovered = 0
  for (const id of ids) {
    if (force) {
      // criteria の各ソースについて worker_states が無ければ error 行を作る
      // （初期化直後にクラッシュして行が生成されていないソースを救済）
      const jrow: any = await c.env.DB.prepare(
        `SELECT criteria_json FROM search_jobs WHERE id=?`
      ).bind(id).first()
      let srcs: string[] = []
      try { srcs = (JSON.parse(jrow?.criteria_json || '{}').sources) || [] } catch (_) {}
      for (const src of srcs) {
        await c.env.DB.prepare(
          `INSERT INTO worker_states (search_job_id, source, phase, message, updated_at)
           VALUES (?,?,'error','[管理: 強制打ち切り]',datetime('now'))
           ON CONFLICT(search_job_id, source) DO NOTHING`
        ).bind(id, src).run()
      }
      // 途中状態の担当を経過時間を問わず error 化
      await c.env.DB.prepare(
        `UPDATE worker_states
         SET phase='error',
             message=COALESCE(NULLIF(message,''),'') || ' [管理: 強制打ち切り]',
             updated_at=datetime('now')
         WHERE search_job_id=? AND phase NOT IN ('done','error','cancelled')`
      ).bind(id).run()
    }
    const done = await maybeCompleteSearch(c.env.DB, id)
    if (done) recovered++
  }

  const still: any = await c.env.DB.prepare(
    `SELECT COUNT(*) as n FROM search_jobs WHERE status='running'`
  ).first()

  return c.json({
    checked: ids.length,
    recovered,
    stillRunning: still?.n ?? 0,
    force,
  })
})

app.get('/api/ingest/pending', async (c) => {
  const auth = c.req.header('X-Ingest-Token')
  if (auth !== (c.env as any).INGEST_TOKEN) return c.json({ error: 'unauthorized' }, 401)

  // 対象: status=running で、そのソースの担当が
  //   (a) phase='skipped'（未着手）… 通常の新規割り当て
  //   (b) 途中状態(fetching/scoring等)のまま STALE_PICKUP_MINUTES 以上更新なし
  //       … worker のクラッシュ/再起動で完了報告が欠落したハング担当。再取得して復旧させる。
  //  ※ done/error/cancelled は確定済みなので対象外。
  const source = c.req.query('source') || 'circus'
  const { results } = await c.env.DB.prepare(
    `SELECT sj.id, sj.criteria_json, sj.top_n
     FROM search_jobs sj
     WHERE sj.status='running'
       AND EXISTS (
         SELECT 1 FROM worker_states ws
         WHERE ws.search_job_id=sj.id AND ws.source=?
           AND (
             ws.phase='skipped'
             OR (
               ws.phase NOT IN ('done','error','cancelled')
               AND ws.updated_at < datetime('now', ?)
             )
           )
       )
     ORDER BY sj.created_at DESC LIMIT 5`
  )
    .bind(source, `-${STALE_PICKUP_MINUTES} minutes`)
    .all()

  return c.json({
    jobs: (results || []).map((r: any) => ({
      searchJobId: r.id,
      criteria: JSON.parse(r.criteria_json),
      topN: r.top_n,
    })),
  })
})

// 外部ワーカー用: 検索ジョブが中止されたかを軽量に確認する。
//   ワーカーは処理ループ内でこれをポーリングし、cancelled なら中断して
//   それまでの部分結果を確定(done報告)する。
app.get('/api/ingest/cancelled', async (c) => {
  const auth = c.req.header('X-Ingest-Token')
  if (auth !== (c.env as any).INGEST_TOKEN) return c.json({ error: 'unauthorized' }, 401)
  const id = c.req.query('id')
  if (!id) return c.json({ error: 'bad request' }, 400)
  const job: any = await c.env.DB.prepare(`SELECT status FROM search_jobs WHERE id=?`).bind(id).first()
  const cancelled = !job || job.status === 'cancelled' || job.status === 'done'
  return c.json({ cancelled, status: job?.status ?? 'missing' })
})

// 外部ワーカーの状態報告
app.post('/api/ingest/state', async (c) => {
  const auth = c.req.header('X-Ingest-Token')
  if (auth !== (c.env as any).INGEST_TOKEN) return c.json({ error: 'unauthorized' }, 401)
  const body = await c.req.json<any>()
  // 部分更新に対応: 渡されなかった数値項目(null)は既存値を保持する(COALESCE)。
  // これにより fetching 途中で scanned だけ送っても total_in_db 等が 0 に消えない。
  const numOrNull = (v: any) => (v === undefined || v === null ? null : v)
  await c.env.DB.prepare(
    `INSERT INTO worker_states
     (search_job_id, source, phase, message, scanned, candidates, matched, from_memory, tokens_used, total_in_db, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,datetime('now'))
     ON CONFLICT(search_job_id, source) DO UPDATE SET
      phase=excluded.phase, message=excluded.message,
      scanned=COALESCE(excluded.scanned, worker_states.scanned),
      candidates=COALESCE(excluded.candidates, worker_states.candidates),
      matched=COALESCE(excluded.matched, worker_states.matched),
      from_memory=COALESCE(excluded.from_memory, worker_states.from_memory),
      tokens_used=COALESCE(excluded.tokens_used, worker_states.tokens_used),
      total_in_db=COALESCE(excluded.total_in_db, worker_states.total_in_db),
      updated_at=datetime('now')`
  )
    .bind(
      body.searchJobId, body.source, body.phase || 'fetching', body.message || '',
      numOrNull(body.scanned), numOrNull(body.candidates), numOrNull(body.matched),
      numOrNull(body.fromMemory), numOrNull(body.tokensUsed), numOrNull(body.totalInDb)
    )
    .run()

  // 完了報告(done)なら、その媒体の「最終検索時の総求人数」を保存。
  //   フロント右上の総求人数はこの値の合算で表示する。
  if (body.phase === 'done' && body.totalInDb != null && Number(body.totalInDb) > 0) {
    await c.env.DB.prepare(
      `INSERT INTO source_totals (source, total, updated_at)
       VALUES (?, ?, datetime('now'))
       ON CONFLICT(source) DO UPDATE SET total=excluded.total, updated_at=datetime('now')`
    ).bind(body.source, Math.round(Number(body.totalInDb))).run()
  }

  // 途中経過の合計を更新。完了/エラー/中止報告なら全ソース確定かチェックしてジョブ確定。
  await refreshSearchTotals(c.env.DB, body.searchJobId)
  if (body.phase === 'done' || body.phase === 'error' || body.phase === 'cancelled') {
    await maybeCompleteSearch(c.env.DB, body.searchJobId)
  }
  return c.json({ ok: true })
})

// 外部ワーカーが見つけた求人結果を払い出し
app.post('/api/ingest/result', async (c) => {
  const auth = c.req.header('X-Ingest-Token')
  if (auth !== (c.env as any).INGEST_TOKEN) return c.json({ error: 'unauthorized' }, 401)
  const body = await c.req.json<any>()
  const { searchJobId, job, score, reason } = body
  if (!searchJobId || !job) return c.json({ error: 'bad request' }, 400)

  // 記憶にも保存
  await c.env.DB.prepare(
    `INSERT OR IGNORE INTO search_results
     (search_job_id, source, source_job_id, score, reason, job_json, from_memory)
     VALUES (?,?,?,?,?,?,0)`
  )
    .bind(searchJobId, job.source, job.sourceJobId, score || 0, reason || '', JSON.stringify(job))
    .run()
  await refreshSearchTotals(c.env.DB, searchJobId)
  return c.json({ ok: true })
})

// =========================================================
// 手動検索モード（自社DB内を直接検索）
//   AI検索とは独立。jobs テーブル(4DBのトレース済み求人)をSQLで絞り込む。
// =========================================================

// 絞り込み候補(ファセット)を返す。プルダウンの選択肢に使う。
app.get('/api/manual/facets', async (c) => {
  const db = c.env.DB
  const distinct = async (col: string): Promise<string[]> => {
    // job_category / industry / employment のユニーク値(上位)を返す
    const { results } = await db
      .prepare(
        `SELECT ${col} AS v, COUNT(*) AS n FROM jobs
         WHERE ${col} IS NOT NULL AND ${col} <> ''
         GROUP BY ${col} ORDER BY n DESC LIMIT 200`
      )
      .all()
    return (results || []).map((r: any) => String(r.v))
  }
  // JSON配列カラム(job_categories_json 等)を展開してユニーク値を集計する。
  //   拡充した職種/業種は配列で保持しているため、フラットな候補一覧を作る。
  const distinctFromJsonArray = async (col: string): Promise<string[]> => {
    const { results } = await db
      .prepare(`SELECT ${col} AS v FROM jobs WHERE ${col} IS NOT NULL AND ${col} <> '' AND ${col} <> '[]'`)
      .all()
    const counts: Record<string, number> = {}
    for (const r of results || []) {
      let arr: string[] = []
      try { arr = JSON.parse((r as any).v) } catch { arr = [] }
      for (const item of arr) {
        const k = String(item).trim()
        if (k) counts[k] = (counts[k] || 0) + 1
      }
    }
    return Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, 300).map(([k]) => k)
  }

  const [
    categories, industries, employments,
    categoriesFlat, industriesFlat, positions,
    genders, educations, locations,
  ] = await Promise.all([
    distinct('job_category'),
    distinct('industry'),
    distinct('employment'),
    distinctFromJsonArray('job_categories_json'),
    distinctFromJsonArray('industries_json'),
    distinctFromJsonArray('positions_json'),
    distinct('required_gender'),
    distinct('required_education'),
    distinctFromJsonArray('locations'),
  ])

  // 成果報酬タイプの件数
  const { results: rewardRows } = await db
    .prepare(
      `SELECT reward_type AS v, COUNT(*) AS n FROM jobs
       WHERE reward_type IS NOT NULL AND reward_type <> '' GROUP BY reward_type ORDER BY n DESC`
    )
    .all()
  const rewardTypes = (rewardRows || []).map((r: any) => String(r.v))

  // 媒体ごとの件数（掲載中/掲載終了）
  const { results: srcRows } = await db
    .prepare(
      `SELECT source, COUNT(*) AS total,
              SUM(CASE WHEN is_open=1 THEN 1 ELSE 0 END) AS open
       FROM jobs GROUP BY source`
    )
    .all()
  const sources: Record<string, { total: number; open: number; label: string }> = {}
  let grandTotal = 0
  let grandOpen = 0
  for (const r of srcRows || []) {
    const s = (r as any).source
    const t = (r as any).total || 0
    const o = (r as any).open || 0
    grandTotal += t
    grandOpen += o
    sources[s] = { total: t, open: o, label: (SOURCE_LABELS as any)[s] || s }
  }

  return c.json({
    categories, industries, employments,
    categoriesFlat, industriesFlat, positions,
    genders, educations, locations, rewardTypes,
    sources,
    totals: { total: grandTotal, open: grandOpen },
  })
})

// 自社DBの手動検索本体
app.get('/api/manual/jobs', async (c) => {
  const db = c.env.DB
  const q = (k: string) => (c.req.query(k) || '').trim()

  const keyword = q('keyword')
  const source = q('source')
  const category = q('category')
  const industry = q('industry')
  const employment = q('employment')
  const location = q('location')
  const position = q('position')       // 役職/ポジション
  const gender = q('gender')           // 性別条件
  const education = q('education')      // 学歴条件
  const rewardType = q('rewardType')   // 成果報酬タイプ
  const ageStr = q('age')              // 応募したい人の年齢(この年齢で応募可能な求人)
  const salaryMin = q('salaryMin')
  const salaryMax = q('salaryMax')
  const openState = q('openState')     // ''(=既定openOnly) | 'open' | 'closed' | 'all'
  const openOnlyLegacy = q('openOnly') // 後方互換
  const sort = q('sort') || 'updated'  // updated|salary_desc|salary_asc|new|source_new
  const page = Math.max(1, parseInt(q('page') || '1', 10) || 1)
  const pageSize = Math.min(100, Math.max(1, parseInt(q('pageSize') || '20', 10) || 20))
  const offset = (page - 1) * pageSize

  const where: string[] = []
  const binds: any[] = []

  // 掲載状態: openState を優先。未指定時は従来どおり掲載中のみ(openOnly=0で全件)。
  if (openState === 'closed') where.push('is_open=0')
  else if (openState === 'all') { /* 制約なし */ }
  else if (openState === 'open') where.push('is_open=1')
  else if (openOnlyLegacy === '0') { /* 全件 */ }
  else where.push('is_open=1')

  if (source) { where.push('source=?'); binds.push(source) }
  if (category) { where.push('(job_category LIKE ? OR job_categories_json LIKE ?)'); binds.push(`%${category}%`, `%${category}%`) }
  if (industry) { where.push('(industry LIKE ? OR industries_json LIKE ?)'); binds.push(`%${industry}%`, `%${industry}%`) }
  if (employment) { where.push('employment LIKE ?'); binds.push(`%${employment}%`) }
  if (location) { where.push('locations LIKE ?'); binds.push(`%${location}%`) }
  if (position) { where.push('positions_json LIKE ?'); binds.push(`%${position}%`) }
  if (gender) { where.push('required_gender = ?'); binds.push(gender) }
  if (education) { where.push('required_education LIKE ?'); binds.push(`%${education}%`) }
  if (rewardType) { where.push('reward_type = ?'); binds.push(rewardType) }
  if (salaryMin) { where.push('(salary_max IS NULL OR salary_max >= ?)'); binds.push(parseInt(salaryMin, 10)) }
  if (salaryMax) { where.push('(salary_min IS NULL OR salary_min <= ?)'); binds.push(parseInt(salaryMax, 10)) }
  // 年齢: 「この年齢の人が応募できる求人」= 下限<=age<=上限（範囲未設定は不問として通す）
  const age = ageStr ? parseInt(ageStr, 10) : null
  if (age != null && Number.isFinite(age)) {
    where.push('(required_age_min IS NULL OR required_age_min <= ?)')
    binds.push(age)
    where.push('(required_age_max IS NULL OR required_age_max >= ?)')
    binds.push(age)
  }
  if (keyword) {
    // タイトル/企業/仕事内容/必須条件/職種/業種/福利厚生を横断。
    // ★重要: 名前付き(?1)と無名(?)プレースホルダを混在させると D1/SQLite の
    //   bind 解釈が崩れ、他フィルタ(gender/rewardType/age等)が誤バインドされて
    //   0件になる。そのため keyword も無名 ? で統一し、値を7回 push する。
    const kw = `%${keyword}%`
    where.push(`(
      title LIKE ? OR company LIKE ? OR description LIKE ?
      OR requirements LIKE ? OR job_category LIKE ? OR industry LIKE ?
      OR benefits LIKE ?
    )`)
    for (let i = 0; i < 7; i++) binds.push(kw)
  }

  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : ''

  let orderSql = 'ORDER BY updated_at DESC'
  if (sort === 'salary_desc') orderSql = 'ORDER BY salary_max DESC NULLS LAST, salary_min DESC'
  else if (sort === 'salary_asc') orderSql = 'ORDER BY salary_min ASC NULLS LAST'
  else if (sort === 'new') orderSql = 'ORDER BY first_seen_at DESC'
  else if (sort === 'source_new') orderSql = "ORDER BY publish_started_at DESC NULLS LAST"

  // すべて無名 ? で順序どおりに構築済み。binds をそのまま使う。
  const finalWhere = whereSql
  const finalBinds = [...binds]

  const countRow: any = await db
    .prepare(`SELECT COUNT(*) AS n FROM jobs ${finalWhere}`)
    .bind(...finalBinds)
    .first()
  const total = countRow?.n || 0

  const { results } = await db
    .prepare(`SELECT * FROM jobs ${finalWhere} ${orderSql} LIMIT ? OFFSET ?`)
    .bind(...finalBinds, pageSize, offset)
    .all()

  const parseArr = (v: any): string[] => {
    if (!v) return []
    try { const a = JSON.parse(v); return Array.isArray(a) ? a : [] } catch { return [] }
  }

  const jobs = (results || []).map((r: any) => {
    let locations: string[] = []
    try { locations = r.locations ? JSON.parse(r.locations) : [] }
    catch { locations = r.locations ? String(r.locations).split(',') : [] }
    // 成果報酬の表示文言（テキストが無ければ率/額から組み立て）
    let rewardText = r.reward_text || ''
    if (!rewardText) {
      if (r.reward_rate != null) rewardText = `理論年収の${r.reward_rate}%`
      else if (r.reward_amount != null) rewardText = `${Math.round(r.reward_amount / 10000)}万円`
    }
    return {
      id: r.id,
      source: r.source,
      sourceLabel: (SOURCE_LABELS as any)[r.source] || r.source,
      sourceJobId: r.source_job_id,
      title: r.title || '',
      company: r.company || '',
      companyWebsite: r.company_website || '',
      jobCategory: r.job_category || '',
      jobCategories: parseArr(r.job_categories_json),
      industry: r.industry || '',
      industries: parseArr(r.industries_json),
      employment: r.employment || '',
      locations,
      positions: parseArr(r.positions_json),
      careerStage: r.career_stage || '',
      experience: parseArr(r.experience_json),
      salaryMin: r.salary_min,
      salaryMax: r.salary_max,
      overtime: r.overtime || '',
      holiday: r.holiday || '',
      benefits: r.benefits || '',
      requirements: r.requirements || '',
      description: r.description || '',
      requiredAgeMin: r.required_age_min,
      requiredAgeMax: r.required_age_max,
      requiredGender: r.required_gender || '',
      requiredEducation: r.required_education || '',
      reward: {
        type: r.reward_type || '',
        rate: r.reward_rate,
        amount: r.reward_amount,
        text: rewardText,
      },
      url: r.url || '',
      isOpen: r.is_open === 1,
      publishStartedAt: r.publish_started_at,
      sourceUpdatedAt: r.source_updated_at,
      firstSeenAt: r.first_seen_at,
      lastSeenAt: r.last_seen_at,
      updatedAt: r.updated_at,
    }
  })

  return c.json({ total, page, pageSize, totalPages: Math.ceil(total / pageSize), jobs })
})

// =========================================================
// トレース(全求人ミラーリング)制御
// =========================================================

// 同期を開始（手動ボタン or cron から呼ばれる）
app.post('/api/trace/start', async (c) => {
  const db = c.env.DB
  let body: any = {}
  try { body = await c.req.json() } catch {}
  const trigger = body.trigger === 'cron' ? 'cron' : 'manual'
  // 対象媒体。未指定なら全4媒体。
  const allSources = ['circus', 'hitolink', 'jobins', 'kintone']
  const sources: string[] = Array.isArray(body.sources) && body.sources.length
    ? body.sources.filter((s: string) => allSources.includes(s))
    : allSources

  // 既に実行中の同期があれば二重起動を防ぐ（30分以上前のものはハングとみなし許可）
  const running: any = await db
    .prepare(
      `SELECT id, started_at FROM trace_jobs
       WHERE status='running' AND started_at > datetime('now','-30 minutes')
       ORDER BY started_at DESC LIMIT 1`
    )
    .first()
  if (running) {
    return c.json({ ok: false, error: 'already_running', traceJobId: running.id }, 409)
  }

  const id = uuid()
  await db
    .prepare(
      `INSERT INTO trace_jobs (id, sources_json, status, trigger, started_at)
       VALUES (?,?, 'running', ?, datetime('now'))`
    )
    .bind(id, JSON.stringify(sources), trigger)
    .run()

  // 各媒体の担当状態を pending で作成 → ワーカーがポーリングで拾う
  for (const s of sources) {
    await db
      .prepare(
        `INSERT OR REPLACE INTO trace_states (trace_job_id, source, phase, message, updated_at)
         VALUES (?,?, 'pending', '同期待機中…', datetime('now'))`
      )
      .bind(id, s)
      .run()
  }

  return c.json({ ok: true, traceJobId: id, sources })
})

// 同期の進捗を取得（フロントのポーリング用）
app.get('/api/trace/status', async (c) => {
  const db = c.env.DB
  const id = c.req.query('id')
  let job: any
  if (id) {
    job = await db.prepare(`SELECT * FROM trace_jobs WHERE id=?`).bind(id).first()
  } else {
    job = await db.prepare(`SELECT * FROM trace_jobs ORDER BY started_at DESC LIMIT 1`).first()
  }
  if (!job) return c.json({ job: null, states: [] })
  const { results } = await db
    .prepare(`SELECT * FROM trace_states WHERE trace_job_id=? ORDER BY source`)
    .bind(job.id)
    .all()
  return c.json({
    job: {
      id: job.id,
      status: job.status,
      trigger: job.trigger,
      sources: JSON.parse(job.sources_json || '[]'),
      startedAt: job.started_at,
      finishedAt: job.finished_at,
      totalUpserted: job.total_upserted,
      totalAdded: job.total_added,
      totalClosed: job.total_closed,
    },
    states: (results || []).map((r: any) => ({
      source: r.source,
      sourceLabel: (SOURCE_LABELS as any)[r.source] || r.source,
      phase: r.phase,
      message: r.message,
      total: r.total,
      fetched: r.fetched,
      upserted: r.upserted,
      added: r.added,
      closed: r.closed,
      skipped: r.skipped || 0,
      failedPages: r.failed_pages || 0,
      updatedAt: r.updated_at,
    })),
  })
})

// --- ワーカー用: トレース待ちの媒体を払い出す ---
app.get('/api/ingest/trace-pending', async (c) => {
  const auth = c.req.header('X-Ingest-Token')
  if (auth !== (c.env as any).INGEST_TOKEN) return c.json({ error: 'unauthorized' }, 401)
  const source = c.req.query('source') || 'circus'
  const { results } = await c.env.DB.prepare(
    `SELECT ts.trace_job_id, tj.started_at
     FROM trace_states ts
     JOIN trace_jobs tj ON tj.id = ts.trace_job_id
     WHERE tj.status='running' AND ts.source=?
       AND (
         ts.phase='pending'
         OR (ts.phase NOT IN ('done','error') AND ts.updated_at < datetime('now','-15 minutes'))
       )
     ORDER BY tj.started_at ASC LIMIT 1`
  ).bind(source).all()
  const jobs = (results || []).map((r: any) => ({
    traceJobId: r.trace_job_id,
    source,
    startedAt: r.started_at,
  }))
  return c.json({ jobs })
})

// --- ワーカー用: トレース進捗の報告 ---
app.post('/api/ingest/trace-state', async (c) => {
  const auth = c.req.header('X-Ingest-Token')
  if (auth !== (c.env as any).INGEST_TOKEN) return c.json({ error: 'unauthorized' }, 401)
  const b = await c.req.json<any>()
  const numOrNull = (v: any) => (v === undefined || v === null ? null : v)
  await c.env.DB.prepare(
    `INSERT INTO trace_states
     (trace_job_id, source, phase, message, total, fetched, upserted, added, closed, skipped, failed_pages, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,datetime('now'))
     ON CONFLICT(trace_job_id, source) DO UPDATE SET
      phase=excluded.phase, message=excluded.message,
      total=COALESCE(excluded.total, trace_states.total),
      fetched=COALESCE(excluded.fetched, trace_states.fetched),
      upserted=COALESCE(excluded.upserted, trace_states.upserted),
      added=COALESCE(excluded.added, trace_states.added),
      closed=COALESCE(excluded.closed, trace_states.closed),
      skipped=COALESCE(excluded.skipped, trace_states.skipped),
      failed_pages=COALESCE(excluded.failed_pages, trace_states.failed_pages),
      updated_at=datetime('now')`
  )
    .bind(
      b.traceJobId, b.source, b.phase || 'fetching', b.message || '',
      numOrNull(b.total), numOrNull(b.fetched), numOrNull(b.upserted),
      numOrNull(b.added), numOrNull(b.closed), numOrNull(b.skipped), numOrNull(b.failedPages)
    )
    .run()

  // 全媒体が done/error なら trace_jobs を確定
  await maybeCompleteTrace(c.env.DB, b.traceJobId)
  return c.json({ ok: true })
})

// --- ワーカー用: 取得した求人をトレース保存（自社DBへupsert）---
app.post('/api/ingest/trace-result', async (c) => {
  const auth = c.req.header('X-Ingest-Token')
  if (auth !== (c.env as any).INGEST_TOKEN) return c.json({ error: 'unauthorized' }, 401)
  const b = await c.req.json<any>()
  const jobs: any[] = Array.isArray(b.jobs) ? b.jobs : (b.job ? [b.job] : [])
  if (!jobs.length) return c.json({ ok: true, added: 0, upserted: 0 })

  let added = 0
  for (const job of jobs) {
    // 新規判定: 既存レコードの有無を事前に確認（正確な追加件数集計のため）
    const exist: any = await c.env.DB
      .prepare(`SELECT id FROM jobs WHERE source=? AND source_job_id=?`)
      .bind(job.source, String(job.sourceJobId))
      .first()
    if (!exist) added++
    const { upsertTraceJob } = await import('./lib/db')
    // ワーカーの mapApiJob が出力する全フィールドをそのまま渡す
    // （リッチ情報の欠落を防ぐため、既知フィールドを網羅してマッピング）
    await upsertTraceJob(c.env.DB, {
      source: job.source,
      sourceJobId: String(job.sourceJobId),
      title: job.title || '',
      company: job.company || '',
      jobCategory: job.jobCategory || '',
      industry: job.industry || '',
      employment: job.employment || '',
      locations: Array.isArray(job.locations) ? job.locations : [],
      salaryMin: job.salaryMin ?? null,
      salaryMax: job.salaryMax ?? null,
      overtime: job.overtime || '',
      holiday: job.holiday || '',
      benefits: job.benefits || '',
      requirements: job.requirements || '',
      description: job.description || '',
      url: job.url || '',
      isOpen: true,
      // --- リッチ情報 ---
      companyWebsite: job.companyWebsite || '',
      jobCategories: Array.isArray(job.jobCategories) ? job.jobCategories : [],
      industries: Array.isArray(job.industries) ? job.industries : [],
      positions: Array.isArray(job.positions) ? job.positions : [],
      careerStage: job.careerStage || '',
      experience: Array.isArray(job.experience) ? job.experience : [],
      requiredAgeMin: job.requiredAgeMin ?? null,
      requiredAgeMax: job.requiredAgeMax ?? null,
      requiredGender: job.requiredGender ?? null,
      requiredEducation: job.requiredEducation ?? null,
      reward: job.reward ?? null,
      publishStartedAt: job.publishStartedAt ?? null,
      lastUpdatedAt: job.lastUpdatedAt ?? null,
      // 元データ。worker は _raw に入れて送ってくる（raw も両対応）
      _raw: job._raw ?? job.raw ?? null,
    } as any)
  }
  return c.json({ ok: true, added, upserted: jobs.length })
})

// --- ワーカー用: 同期完了時に掲載終了(is_open=0)を確定させる ---
app.post('/api/ingest/trace-close', async (c) => {
  const auth = c.req.header('X-Ingest-Token')
  if (auth !== (c.env as any).INGEST_TOKEN) return c.json({ error: 'unauthorized' }, 401)
  const b = await c.req.json<any>()
  const { source, startedAt } = b
  if (!source || !startedAt) return c.json({ error: 'bad request' }, 400)
  const { closeStaleTraceJobs } = await import('./lib/db')
  const closed = await closeStaleTraceJobs(c.env.DB, source, startedAt)
  return c.json({ ok: true, closed })
})

// --- ワーカー用(差分同期): この媒体の既存 source_job_id → content_hash マップ ---
app.get('/api/ingest/trace-hashes', async (c) => {
  const auth = c.req.header('X-Ingest-Token')
  if (auth !== (c.env as any).INGEST_TOKEN) return c.json({ error: 'unauthorized' }, 401)
  const source = c.req.query('source') || ''
  if (!source) return c.json({ error: 'bad request' }, 400)
  const { getExistingHashes } = await import('./lib/db')
  const hashes = await getExistingHashes(c.env.DB, source as any)
  return c.json({ ok: true, source, count: Object.keys(hashes).length, hashes })
})

// --- ワーカー用(差分同期): IDが一致し内容変化なしの求人の掲載確認印だけ更新 ---
app.post('/api/ingest/trace-touch', async (c) => {
  const auth = c.req.header('X-Ingest-Token')
  if (auth !== (c.env as any).INGEST_TOKEN) return c.json({ error: 'unauthorized' }, 401)
  const b = await c.req.json<any>()
  const { source } = b
  const ids: string[] = Array.isArray(b.sourceJobIds) ? b.sourceJobIds.map((x: any) => String(x)) : []
  if (!source || !ids.length) return c.json({ ok: true, touched: 0 })
  const { touchTraceJobs } = await import('./lib/db')
  const touched = await touchTraceJobs(c.env.DB, source as any, ids)
  return c.json({ ok: true, touched })
})

// 全媒体の担当が done/error になったら trace_jobs を確定し、合計を集計する。
async function maybeCompleteTrace(db: D1, traceJobId: string): Promise<void> {
  const job: any = await db.prepare(`SELECT * FROM trace_jobs WHERE id=?`).bind(traceJobId).first()
  if (!job || job.status !== 'running') return
  const sources: string[] = JSON.parse(job.sources_json || '[]')
  const { results } = await db
    .prepare(`SELECT * FROM trace_states WHERE trace_job_id=?`)
    .bind(traceJobId)
    .all()
  const states = results || []
  const finished = states.filter((s: any) => s.phase === 'done' || s.phase === 'error')
  if (finished.length < sources.length) return // まだ実行中の媒体がある

  const anyError = states.some((s: any) => s.phase === 'error')
  const totalUpserted = states.reduce((a: number, s: any) => a + (s.upserted || 0), 0)
  const totalAdded = states.reduce((a: number, s: any) => a + (s.added || 0), 0)
  const totalClosed = states.reduce((a: number, s: any) => a + (s.closed || 0), 0)
  await db
    .prepare(
      `UPDATE trace_jobs SET status=?, finished_at=datetime('now'),
        total_upserted=?, total_added=?, total_closed=?
       WHERE id=?`
    )
    .bind(anyError ? 'error' : 'done', totalUpserted, totalAdded, totalClosed, traceJobId)
    .run()
}

// ---------------------------------------------------------
// フロントUI
// ---------------------------------------------------------
// ファビコン（インラインSVG。ヘッダーのテーマ色＝インディゴの虫眼鏡アイコン）
const FAVICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">
  <defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
    <stop offset="0" stop-color="#6366f1"/><stop offset="1" stop-color="#2563eb"/>
  </linearGradient></defs>
  <rect width="64" height="64" rx="14" fill="url(#g)"/>
  <circle cx="28" cy="28" r="12" fill="none" stroke="#fff" stroke-width="4.5"/>
  <line x1="37" y1="37" x2="48" y2="48" stroke="#fff" stroke-width="5.5" stroke-linecap="round"/>
</svg>`

const faviconResponse = (c: any) =>
  c.body(FAVICON_SVG, 200, {
    'Content-Type': 'image/svg+xml',
    'Cache-Control': 'public, max-age=86400',
  })

app.get('/favicon.ico', faviconResponse)
app.get('/favicon.svg', faviconResponse)

app.get('/', (c) => {
  return c.html(renderPage())
})

// ---------------------------------------------------------
// 手動検索モード（新）: 求人データハブ（hub/）の検索画面を表示する
//   hub の検索サーバー（PM2: hub-api、127.0.0.1:3100 のサーバー内部専用）へ中継する。
//   旧画面は /manual-old に残している（切り戻し用）。
//   中継先は .dev.vars の HUB_API_URL で変更可（既定 http://127.0.0.1:3100）
// ---------------------------------------------------------
const hubBase = (c: any) => ((c.env as any).HUB_API_URL || 'http://127.0.0.1:3100').replace(/\/$/, '')
const hubDown = (c: any, e: any) =>
  c.html(`<!DOCTYPE html><meta charset="utf-8"><title>手動検索</title>
    <body style="font-family:sans-serif;padding:2rem;line-height:1.8">
    <h1>手動検索の検索サーバーに接続できません</h1>
    <p>VPSで <code>pm2 list</code> を実行し、<b>hub-api</b> が online か確認してください。</p>
    <p>停止している場合: <code>pm2 start ecosystem.config.cjs --only hub-api</code></p>
    <p><a href="/">← AI検索に戻る</a>　<a href="/manual-old">旧・手動検索</a></p>
    <p style="color:#888;font-size:12px">${String(e && e.message || e).replace(/[<>&]/g, '')}</p></body>`, 502)

app.get('/manual', async (c) => {
  try {
    const r = await fetch(`${hubBase(c)}/`, { signal: AbortSignal.timeout(5000) })
    if (!r.ok) throw new Error(`hub-api ${r.status}`)
    const html = (await r.text()).replace('<meta name="api-base" content="">', '<meta name="api-base" content="/hub-api">')
    return c.html(html)
  } catch (e) {
    return hubDown(c, e)
  }
})

// hub の読み取り用API への中継（GET のみ・決まったパスのみ）
app.get('/hub-api/api/*', async (c) => {
  const url = new URL(c.req.url)
  const path = url.pathname.replace(/^\/hub-api/, '')
  if (!/^\/api\/(overview|jobs(\/\d+)?)$/.test(path)) return c.json({ error: 'not_found' }, 404)
  try {
    const r = await fetch(`${hubBase(c)}${path}${url.search}`, { signal: AbortSignal.timeout(15000) })
    return new Response(r.body, {
      status: r.status,
      headers: { 'Content-Type': r.headers.get('Content-Type') || 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
    })
  } catch (e: any) {
    return c.json({ error: 'hub_unavailable', message: String(e?.message || e) }, 502)
  }
})

// 旧・手動検索モード（切り戻し用に残す。新画面が安定したら削除）
app.get('/manual-old', (c) => {
  return c.html(renderManualPage())
})

export default app
