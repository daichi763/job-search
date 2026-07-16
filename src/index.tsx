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

// ---------------------------------------------------------
// 検索開始
// ---------------------------------------------------------
app.post('/api/search', async (c) => {
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

  const sources: SourceId[] = ['kintone', 'circus', 'hitolink', 'jobins']
  for (const s of sources) {
    stats[s] = {
      label: SOURCE_LABELS[s],
      total: s === 'kintone' ? kintoneTotal : (cacheMap[s]?.cached ?? 0),
      cached: cacheMap[s]?.cached ?? 0,
      openCached: cacheMap[s]?.open ?? 0,
      connected: s === 'kintone', // 現状kintoneのみ接続済み
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
app.get('/api/ingest/pending', async (c) => {
  const auth = c.req.header('X-Ingest-Token')
  if (auth !== (c.env as any).INGEST_TOKEN) return c.json({ error: 'unauthorized' }, 401)

  const { results } = await c.env.DB.prepare(
    `SELECT sj.id, sj.criteria_json, sj.top_n
     FROM search_jobs sj
     WHERE sj.status='running'
       AND EXISTS (
         SELECT 1 FROM worker_states ws
         WHERE ws.search_job_id=sj.id AND ws.source=? AND ws.phase='skipped'
       )
     ORDER BY sj.created_at DESC LIMIT 5`
  )
    .bind(c.req.query('source') || 'circus')
    .all()

  return c.json({
    jobs: (results || []).map((r: any) => ({
      searchJobId: r.id,
      criteria: JSON.parse(r.criteria_json),
      topN: r.top_n,
    })),
  })
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

  // 途中経過の合計を更新。完了報告なら全ソース完了かチェックしてジョブ完了。
  await refreshSearchTotals(c.env.DB, body.searchJobId)
  if (body.phase === 'done' || body.phase === 'error') {
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
app.get('/favicon.ico', (c) => {
  return c.body(null, 204)
})

app.get('/', (c) => {
  return c.html(renderPage())
})

export default app
