import { Hono } from 'hono'
import { cors } from 'hono/cors'
import type { Env } from './lib/orchestrator'
import { runSearch, maybeCompleteSearch, refreshSearchTotals } from './lib/orchestrator'
import { fetchKintoneCount } from './lib/kintone'
import type { SearchCriteria, SourceId } from './lib/types'
import { SOURCE_LABELS } from './lib/types'
import { renderPage } from './ui'

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

export default app
