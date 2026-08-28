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

// ============================================================
// 手動検索モード: 全求人トレース(ミラーリング)用の upsert
//   通常の upsertJob との違い:
//    ・trace_sync_at に現在時刻を刻む(=今回の同期で掲載を確認できた印)。
//    ・is_open を必ず1(公開中)に戻す(再掲載された求人の復活に対応)。
//    ・各アダプタが出力するリッチ情報(成果報酬/年齢/性別/学歴/職種配列 等)を
//      専用列へ保存し、raw_json には _raw(元データ)を丸ごと格納する。
// ============================================================

// NormalizedJob(worker側) → jobsテーブル拡張列にマッピングするための正規化。
//   worker は raw を `_raw` に格納するため、job.raw / job._raw の両対応にする。
function extractRich(job: any) {
  const rawObj = job._raw ?? job.raw ?? null
  const reward = job.reward || {}
  return {
    companyWebsite: job.companyWebsite || '',
    jobCategoriesJson: JSON.stringify(Array.isArray(job.jobCategories) ? job.jobCategories : []),
    industriesJson: JSON.stringify(Array.isArray(job.industries) ? job.industries : []),
    positionsJson: JSON.stringify(Array.isArray(job.positions) ? job.positions : []),
    careerStage: job.careerStage || '',
    experienceJson: JSON.stringify(Array.isArray(job.experience) ? job.experience : []),
    requiredAgeMin: job.requiredAgeMin ?? null,
    requiredAgeMax: job.requiredAgeMax ?? null,
    requiredGender: job.requiredGender ?? null,
    requiredEducation: job.requiredEducation ?? null,
    rewardType: reward.type ?? null,
    rewardRate: reward.rate ?? null,
    rewardAmount: reward.amount ?? null,
    rewardText: reward.text ?? '',
    publishStartedAt: job.publishStartedAt ?? null,
    sourceUpdatedAt: job.lastUpdatedAt ?? null,
    rawJson: rawObj ? JSON.stringify(rawObj) : null,
  }
}

// 内容ハッシュ: 差分同期(変化がなければ軽量スキップ)判定に使う。
//   ★ worker/trace.js の computeContentHash と完全に同じロジックにすること。
//     (ワーカー側でスキップ判定するハッシュと、ここで保存するハッシュを一致させる)
//   主要フィールドを連結した簡易ハッシュ(FNV-1a)。厳密さより速度優先。
export function computeContentHash(job: any): string {
  const rawReward = (job as any).reward || {}
  const arr = (v: any) => JSON.stringify(Array.isArray(v) ? v : [])
  const s = [
    job.title, job.company, job.jobCategory, job.industry, job.employment,
    arr(job.locations), job.salaryMin, job.salaryMax,
    job.overtime, job.holiday, (job as any).benefits || '', job.requirements, job.description,
    job.url, (job as any).companyWebsite || '', arr((job as any).jobCategories), arr((job as any).industries),
    arr((job as any).positions), (job as any).careerStage || '', arr((job as any).experience),
    (job as any).requiredAgeMin ?? null, (job as any).requiredAgeMax ?? null,
    (job as any).requiredGender ?? null, (job as any).requiredEducation ?? null,
    rawReward.type ?? null, rawReward.rate ?? null, rawReward.amount ?? null, rawReward.text ?? '',
  ].join('\u0001')
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0
  }
  return h.toString(16)
}

// 差分同期: この媒体の既存 source_job_id → content_hash のマップを返す。
//   ワーカーが「IDが一致し内容も同じものはスキップ」判定するために使う。
export async function getExistingHashes(
  db: D1,
  source: SourceId
): Promise<Record<string, string>> {
  const { results } = await db
    .prepare(`SELECT source_job_id, content_hash FROM jobs WHERE source=?`)
    .bind(source)
    .all()
  const map: Record<string, string> = {}
  for (const r of results || []) {
    map[String((r as any).source_job_id)] = (r as any).content_hash || ''
  }
  return map
}

// 差分同期: 既存かつ内容一致(=スキップ扱い)の求人について、掲載確認印だけ更新する。
//   まとめて trace_sync_at / last_seen_at / is_open を更新する軽量パス。
export async function touchTraceJobs(
  db: D1,
  source: SourceId,
  sourceJobIds: string[]
): Promise<number> {
  if (!sourceJobIds.length) return 0
  let touched = 0
  const CHUNK = 100
  for (let i = 0; i < sourceJobIds.length; i += CHUNK) {
    const chunk = sourceJobIds.slice(i, i + CHUNK)
    const placeholders = chunk.map(() => '?').join(',')
    const res = await db
      .prepare(
        `UPDATE jobs
         SET trace_sync_at=datetime('now'), last_seen_at=datetime('now'), is_open=1
         WHERE source=? AND source_job_id IN (${placeholders})`
      )
      .bind(source, ...chunk)
      .run()
    touched += res.meta?.changes ?? 0
  }
  return touched
}

export async function upsertTraceJob(db: D1, job: NormalizedJob): Promise<{ added: boolean }> {
  const rich = extractRich(job)
  const hash = computeContentHash(job)
  await db
    .prepare(
      `INSERT INTO jobs
       (source, source_job_id, title, company, job_category, industry, employment,
        locations, salary_min, salary_max, overtime, holiday, benefits, requirements,
        description, raw_json, url, is_open,
        company_website, job_categories_json, industries_json, positions_json, career_stage,
        experience_json, required_age_min, required_age_max, required_gender, required_education,
        reward_type, reward_rate, reward_amount, reward_text, publish_started_at, source_updated_at,
        content_hash, trace_sync_at, first_seen_at, last_seen_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,1,
        ?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,
        datetime('now'),datetime('now'),datetime('now'),datetime('now'))
       ON CONFLICT(source, source_job_id) DO UPDATE SET
        title=excluded.title, company=excluded.company, job_category=excluded.job_category,
        industry=excluded.industry, employment=excluded.employment, locations=excluded.locations,
        salary_min=excluded.salary_min, salary_max=excluded.salary_max, overtime=excluded.overtime,
        holiday=excluded.holiday, benefits=excluded.benefits, requirements=excluded.requirements,
        description=excluded.description, raw_json=excluded.raw_json, url=excluded.url,
        company_website=excluded.company_website, job_categories_json=excluded.job_categories_json,
        industries_json=excluded.industries_json, positions_json=excluded.positions_json,
        career_stage=excluded.career_stage, experience_json=excluded.experience_json,
        required_age_min=excluded.required_age_min, required_age_max=excluded.required_age_max,
        required_gender=excluded.required_gender, required_education=excluded.required_education,
        reward_type=excluded.reward_type, reward_rate=excluded.reward_rate,
        reward_amount=excluded.reward_amount, reward_text=excluded.reward_text,
        publish_started_at=excluded.publish_started_at, source_updated_at=excluded.source_updated_at,
        content_hash=excluded.content_hash,
        is_open=1, trace_sync_at=datetime('now'),
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
      (job as any).benefits || '',
      job.requirements,
      job.description,
      rich.rawJson,
      job.url,
      rich.companyWebsite,
      rich.jobCategoriesJson,
      rich.industriesJson,
      rich.positionsJson,
      rich.careerStage,
      rich.experienceJson,
      rich.requiredAgeMin,
      rich.requiredAgeMax,
      rich.requiredGender,
      rich.requiredEducation,
      rich.rewardType,
      rich.rewardRate,
      rich.rewardAmount,
      rich.rewardText,
      rich.publishStartedAt,
      rich.sourceUpdatedAt,
      hash
    )
    .run()
  // 新規判定は呼び出し側(index.tsx /api/ingest/trace-result)で
  // 事前SELECTにより正確に行うため、ここでは常に false を返す。
  return { added: false }
}

// 同期完了後: 今回の同期で掲載確認できなかった求人を掲載終了(is_open=0)にする。
//   startedAt(同期開始時刻)より trace_sync_at が古い or NULL の
//   「その媒体でトレース対象の」求人が対象。
//   ただし trace_sync_at が一度も入ったことのない行(AI検索由来)は誤判定しないよう、
//   「これまでに一度でもトレースされたことがある行(trace_sync_at IS NOT NULL)」のみを対象にする。
export async function closeStaleTraceJobs(
  db: D1,
  source: SourceId,
  startedAt: string
): Promise<number> {
  const res = await db
    .prepare(
      `UPDATE jobs
       SET is_open=0, updated_at=datetime('now')
       WHERE source=?
         AND is_open=1
         AND trace_sync_at IS NOT NULL
         AND trace_sync_at < ?`
    )
    .bind(source, startedAt)
    .run()
  return res.meta?.changes ?? 0
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
