// D1 データアクセス層
import type { NormalizedJob, SourceId } from './types'

export type D1 = D1Database

// 求人キャッシュへのupsert（記憶）
export async function upsertJob(db: D1, job: NormalizedJob): Promise<void> {
  await db
    .prepare(
      `INSERT INTO jobs
       (source, source_job_id, title, company, job_category, industry, employment,
        locations, salary_min, salary_max, overtime, holiday, benefits, requirements,
        description, raw_json, url, is_open, last_seen_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,datetime('now'),datetime('now'))
       ON CONFLICT(source, source_job_id) DO UPDATE SET
        title=excluded.title, company=excluded.company, job_category=excluded.job_category,
        industry=excluded.industry, employment=excluded.employment, locations=excluded.locations,
        salary_min=excluded.salary_min, salary_max=excluded.salary_max, overtime=excluded.overtime,
        holiday=excluded.holiday, benefits=excluded.benefits, requirements=excluded.requirements,
        description=excluded.description, url=excluded.url, is_open=excluded.is_open,
        last_seen_at=datetime('now'), updated_at=datetime('now')`
    )
    .bind(
      job.source,
      job.sourceJobId,
      job.title,
      job.company,
      job.jobCategory,
      job.industry,
      job.employment,
      JSON.stringify(job.locations),
      job.salaryMin,
      job.salaryMax,
      job.overtime,
      job.holiday,
      job.benefits,
      job.requirements,
      job.description,
      job.raw ? JSON.stringify(job.raw) : null,
      job.url,
      job.isOpen ? 1 : 0
    )
    .run()
}

export async function upsertJobsBatch(db: D1, jobs: NormalizedJob[]): Promise<void> {
  // D1のbatchで高速化
  const stmt = db.prepare(
    `INSERT INTO jobs
      (source, source_job_id, title, company, job_category, industry, employment,
       locations, salary_min, salary_max, overtime, holiday, benefits, requirements,
       description, url, is_open, last_seen_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,datetime('now'),datetime('now'))
     ON CONFLICT(source, source_job_id) DO UPDATE SET
       title=excluded.title, company=excluded.company, job_category=excluded.job_category,
       industry=excluded.industry, employment=excluded.employment, locations=excluded.locations,
       salary_min=excluded.salary_min, salary_max=excluded.salary_max, overtime=excluded.overtime,
       holiday=excluded.holiday, benefits=excluded.benefits, requirements=excluded.requirements,
       description=excluded.description, url=excluded.url, is_open=excluded.is_open,
       last_seen_at=datetime('now'), updated_at=datetime('now')`
  )
  const batch = jobs.map((job) =>
    stmt.bind(
      job.source, job.sourceJobId, job.title, job.company, job.jobCategory,
      job.industry, job.employment, JSON.stringify(job.locations),
      job.salaryMin, job.salaryMax, job.overtime, job.holiday, job.benefits,
      job.requirements, job.description, job.url, job.isOpen ? 1 : 0
    )
  )
  // D1 batchは最大件数制限があるためチャンク分割
  const CHUNK = 50
  for (let i = 0; i < batch.length; i += CHUNK) {
    await db.batch(batch.slice(i, i + CHUNK))
  }
}

// キャッシュから求人を読み出す（記憶からの高速提案用）
export async function getCachedJobs(
  db: D1,
  source: SourceId,
  onlyOpen = true
): Promise<NormalizedJob[]> {
  const q = onlyOpen
    ? `SELECT * FROM jobs WHERE source=? AND is_open=1`
    : `SELECT * FROM jobs WHERE source=?`
  const { results } = await db.prepare(q).bind(source).all()
  return (results || []).map(rowToJob)
}

function rowToJob(r: any): NormalizedJob {
  let locations: string[] = []
  try {
    locations = r.locations ? JSON.parse(r.locations) : []
  } catch {
    locations = r.locations ? String(r.locations).split(',') : []
  }
  return {
    source: r.source,
    sourceJobId: r.source_job_id,
    title: r.title || '',
    company: r.company || '',
    jobCategory: r.job_category || '',
    industry: r.industry || '',
    employment: r.employment || '',
    locations,
    salaryMin: r.salary_min,
    salaryMax: r.salary_max,
    overtime: r.overtime || '',
    holiday: r.holiday || '',
    benefits: r.benefits || '',
    requirements: r.requirements || '',
    description: r.description || '',
    url: r.url || '',
    isOpen: r.is_open === 1,
  }
}

// worker状態の更新
export async function updateWorkerState(
  db: D1,
  searchJobId: string,
  source: SourceId,
  patch: Partial<{
    phase: string
    message: string
    scanned: number
    candidates: number
    matched: number
    from_memory: number
    tokens_used: number
    total_in_db: number
  }>
): Promise<void> {
  // 既存行を取得してマージ
  const existing: any = await db
    .prepare(`SELECT * FROM worker_states WHERE search_job_id=? AND source=?`)
    .bind(searchJobId, source)
    .first()

  const merged = {
    phase: patch.phase ?? existing?.phase ?? 'idle',
    message: patch.message ?? existing?.message ?? '',
    scanned: patch.scanned ?? existing?.scanned ?? 0,
    candidates: patch.candidates ?? existing?.candidates ?? 0,
    matched: patch.matched ?? existing?.matched ?? 0,
    from_memory: patch.from_memory ?? existing?.from_memory ?? 0,
    tokens_used: patch.tokens_used ?? existing?.tokens_used ?? 0,
    total_in_db: patch.total_in_db ?? existing?.total_in_db ?? 0,
  }

  await db
    .prepare(
      `INSERT INTO worker_states
       (search_job_id, source, phase, message, scanned, candidates, matched, from_memory, tokens_used, total_in_db, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,datetime('now'))
       ON CONFLICT(search_job_id, source) DO UPDATE SET
        phase=excluded.phase, message=excluded.message, scanned=excluded.scanned,
        candidates=excluded.candidates, matched=excluded.matched, from_memory=excluded.from_memory,
        tokens_used=excluded.tokens_used, total_in_db=excluded.total_in_db, updated_at=datetime('now')`
    )
    .bind(
      searchJobId, source, merged.phase, merged.message, merged.scanned,
      merged.candidates, merged.matched, merged.from_memory, merged.tokens_used, merged.total_in_db
    )
    .run()
}

// AI採点結果を記憶（次回の高速提案用）
export async function rememberScore(
  db: D1,
  criteriaHash: string,
  source: SourceId,
  sourceJobId: string,
  score: number,
  reason: string
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO score_memory (criteria_hash, source, source_job_id, score, reason, scored_at)
       VALUES (?,?,?,?,?,datetime('now'))
       ON CONFLICT(criteria_hash, source, source_job_id) DO UPDATE SET
        score=excluded.score, reason=excluded.reason, scored_at=datetime('now')`
    )
    .bind(criteriaHash, source, sourceJobId, score, reason)
    .run()
}

// 記憶した採点結果を取得（source_job_id -> {score, reason}）
export async function recallScores(
  db: D1,
  criteriaHash: string,
  source: SourceId
): Promise<Record<string, { score: number; reason: string }>> {
  const { results } = await db
    .prepare(`SELECT source_job_id, score, reason FROM score_memory WHERE criteria_hash=? AND source=?`)
    .bind(criteriaHash, source)
    .all()
  const map: Record<string, { score: number; reason: string }> = {}
  for (const r of results || []) {
    map[(r as any).source_job_id] = { score: (r as any).score, reason: (r as any).reason || '' }
  }
  return map
}

// 検索結果の払い出し（逐次INSERT）
export async function pushResult(
  db: D1,
  searchJobId: string,
  job: NormalizedJob,
  score: number,
  reason: string,
  fromMemory: boolean
): Promise<void> {
  await db
    .prepare(
      `INSERT OR IGNORE INTO search_results
       (search_job_id, source, source_job_id, score, reason, job_json, from_memory)
       VALUES (?,?,?,?,?,?,?)`
    )
    .bind(
      searchJobId,
      job.source,
      job.sourceJobId,
      score,
      reason,
      JSON.stringify(job),
      fromMemory ? 1 : 0
    )
    .run()
}
