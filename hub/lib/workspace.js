// ============================================================
// 作業用DB（hub/data/workspace.sqlite）
//   求人DB（jobs_hub.sqlite）とは分けて、担当者の作業データを保存する
//   ・candidates          … 求職者（名前＋自動採番。画面では No.123）
//   ・candidate_documents … 書類（PDFは保存しない。個人情報を伏せた本文だけ）
//   ・referrals           … 紹介済みの求人（AI検索で自動的に除外する）
//   ・ai_searches         … AI検索の実行（条件・進捗・要約・費用・担当者）
//   ・ai_results          … AI検索の結果（提案・参考）
//   担当者（ログイン）は webapp 側（D1）で管理し、ここには ID と名前の写しだけ残す
// ============================================================
import { DatabaseSync } from 'node:sqlite'
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'

const SCHEMA = `
CREATE TABLE IF NOT EXISTS candidates (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  name               TEXT NOT NULL,
  name_kana          TEXT,
  memo               TEXT,                 -- 担当者のメモ（AI検索でも参照する）
  conditions_json    TEXT,                 -- 最後に使った検索条件（呼び出して再検索する用）
  profile_json       TEXT,                 -- 書類から読み取った経歴
  profile_hash       TEXT,                 -- どの書類・メモから作ったか（変わったら作り直す）
  profile_updated_at TEXT,
  owner_user_id      INTEGER,              -- 主担当
  owner_user_name    TEXT,
  created_by_name    TEXT,
  created_at         TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at         TEXT NOT NULL DEFAULT (datetime('now')),
  archived           INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_candidates_updated ON candidates(archived, updated_at);

CREATE TABLE IF NOT EXISTS candidate_documents (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  candidate_id    INTEGER NOT NULL,
  kind            TEXT NOT NULL DEFAULT 'other',  -- resume=履歴書 | cv=職務経歴書 | other
  filename        TEXT,
  masked_text     TEXT NOT NULL,                  -- 個人情報を伏せた本文
  pages           INTEGER,
  chars           INTEGER,
  created_by_name TEXT,
  created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_docs_candidate ON candidate_documents(candidate_id);

CREATE TABLE IF NOT EXISTS referrals (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  candidate_id    INTEGER NOT NULL,
  job_key         TEXT NOT NULL,                  -- 媒体:求人ID
  title           TEXT,
  company         TEXT,
  note            TEXT,
  search_id       TEXT,
  created_by_name TEXT,
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(candidate_id, job_key)
);

CREATE TABLE IF NOT EXISTS ai_searches (
  id             TEXT PRIMARY KEY,
  candidate_id   INTEGER,
  user_id        INTEGER,
  user_name      TEXT,
  criteria_json  TEXT NOT NULL,
  options_json   TEXT,
  status         TEXT NOT NULL DEFAULT 'queued',  -- queued | running | done | error | cancelled
  stage          TEXT,
  message        TEXT,
  log_json       TEXT,                            -- 進捗メッセージ（直近）
  plan_json      TEXT,
  summary_json   TEXT,
  usd            REAL,
  error          TEXT,
  cancel_requested INTEGER NOT NULL DEFAULT 0,
  created_at     TEXT NOT NULL DEFAULT (datetime('now')),
  started_at     TEXT,
  finished_at    TEXT
);
CREATE INDEX IF NOT EXISTS idx_searches_candidate ON ai_searches(candidate_id, created_at);
CREATE INDEX IF NOT EXISTS idx_searches_status ON ai_searches(status, created_at);

CREATE TABLE IF NOT EXISTS ai_results (
  search_id  TEXT NOT NULL,
  kind       TEXT NOT NULL,                       -- recommended | reference
  rank       INTEGER NOT NULL,
  job_key    TEXT NOT NULL,
  job_id     INTEGER,
  score      INTEGER,
  data_json  TEXT NOT NULL,
  PRIMARY KEY (search_id, kind, rank)
);
`

export function openWorkspace(file) {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
  const db = new DatabaseSync(file)
  db.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON;')
  db.exec(SCHEMA)
  if (file !== ':memory:') { try { fs.chmodSync(file, 0o600) } catch {} }
  return db
}

const now = () => new Date().toISOString().replace('T', ' ').slice(0, 19)
const j = (s, d = null) => { if (s == null) return d; try { return JSON.parse(s) } catch { return d } }
const clean = (s, n) => (s == null ? null : String(s).trim().slice(0, n) || null)

// ---------------- 求職者 ----------------
export function listCandidates(db, { q = '', owner = null, limit = 50, offset = 0, archived = false } = {}) {
  const where = ['c.archived = ?'], args = [archived ? 1 : 0]
  const s = String(q || '').trim()
  if (s) {
    const id = s.replace(/^No\.?\s*/i, '')
    if (/^\d+$/.test(id)) { where.push('(c.id = ? OR c.name LIKE ? OR c.name_kana LIKE ?)'); args.push(Number(id), `%${s}%`, `%${s}%`) }
    else { where.push('(c.name LIKE ? OR c.name_kana LIKE ? OR c.memo LIKE ?)'); args.push(`%${s}%`, `%${s}%`, `%${s}%`) }
  }
  if (owner) { where.push('c.owner_user_id = ?'); args.push(Number(owner)) }
  const w = where.join(' AND ')
  const total = db.prepare(`SELECT COUNT(*) AS n FROM candidates c WHERE ${w}`).get(...args).n
  const rows = db.prepare(`SELECT c.id, c.name, c.name_kana, c.owner_user_name, c.updated_at, c.created_at,
      (SELECT COUNT(*) FROM candidate_documents d WHERE d.candidate_id=c.id) AS doc_count,
      (SELECT COUNT(*) FROM referrals r WHERE r.candidate_id=c.id) AS referral_count,
      (SELECT COUNT(*) FROM ai_searches s WHERE s.candidate_id=c.id) AS search_count,
      (SELECT MAX(created_at) FROM ai_searches s WHERE s.candidate_id=c.id) AS last_search_at
    FROM candidates c WHERE ${w} ORDER BY c.updated_at DESC, c.id DESC LIMIT ? OFFSET ?`).all(...args, Math.min(200, limit), offset)
  return { total, items: rows }
}

export function getCandidate(db, id) {
  const c = db.prepare('SELECT * FROM candidates WHERE id=?').get(Number(id))
  if (!c) return null
  const docs = db.prepare('SELECT id, kind, filename, pages, chars, created_by_name, created_at FROM candidate_documents WHERE candidate_id=? ORDER BY id').all(c.id)
  const referrals = db.prepare('SELECT id, job_key, title, company, note, search_id, created_by_name, created_at FROM referrals WHERE candidate_id=? ORDER BY id DESC').all(c.id)
  const searches = db.prepare(`SELECT id, user_name, status, usd, created_at, finished_at, summary_json, criteria_json FROM ai_searches
      WHERE candidate_id=? ORDER BY created_at DESC LIMIT 50`).all(c.id).map(searchRow)
  return {
    id: c.id, name: c.name, name_kana: c.name_kana, memo: c.memo, conditions: j(c.conditions_json, {}),
    profile: j(c.profile_json), profile_updated_at: c.profile_updated_at, profile_fresh: !!c.profile_json && c.profile_hash === profileHash(db, c.id),
    owner_user_id: c.owner_user_id, owner_user_name: c.owner_user_name, created_by_name: c.created_by_name,
    created_at: c.created_at, updated_at: c.updated_at, archived: !!c.archived, documents: docs, referrals, searches,
  }
}

export function createCandidate(db, body, user) {
  const name = clean(body.name, 60)
  if (!name) return { ok: false, error: '名前を入力してください' }
  const r = db.prepare(`INSERT INTO candidates (name, name_kana, memo, owner_user_id, owner_user_name, created_by_name) VALUES (?,?,?,?,?,?)`)
    .run(name, clean(body.name_kana, 60), clean(body.memo, 4000), user?.id ?? null, user?.name ?? null, user?.name ?? null)
  return { ok: true, id: Number(r.lastInsertRowid) }
}

export function updateCandidate(db, id, body) {
  const c = db.prepare('SELECT id FROM candidates WHERE id=?').get(Number(id))
  if (!c) return { ok: false, error: '求職者が見つかりません' }
  const sets = [], args = []
  if (body.name !== undefined) { const n = clean(body.name, 60); if (!n) return { ok: false, error: '名前を入力してください' }; sets.push('name=?'); args.push(n) }
  if (body.name_kana !== undefined) { sets.push('name_kana=?'); args.push(clean(body.name_kana, 60)) }
  if (body.memo !== undefined) { sets.push('memo=?'); args.push(clean(body.memo, 4000)) }
  if (body.archived !== undefined) { sets.push('archived=?'); args.push(body.archived ? 1 : 0) }
  if (body.owner_user_id !== undefined) { sets.push('owner_user_id=?', 'owner_user_name=?'); args.push(body.owner_user_id, clean(body.owner_user_name, 50)) }
  if (!sets.length) return { ok: true }
  sets.push('updated_at=?'); args.push(now())
  db.prepare(`UPDATE candidates SET ${sets.join(', ')} WHERE id=?`).run(...args, Number(id))
  return { ok: true }
}

// 求職者の完全削除（書類・紹介済み・検索履歴・結果もすべて消す。個人情報の削除依頼に対応）
export function deleteCandidate(db, id) {
  const cid = Number(id)
  const ids = db.prepare('SELECT id FROM ai_searches WHERE candidate_id=?').all(cid).map((r) => r.id)
  db.exec('BEGIN')
  try {
    for (const sid of ids) db.prepare('DELETE FROM ai_results WHERE search_id=?').run(sid)
    db.prepare('DELETE FROM ai_searches WHERE candidate_id=?').run(cid)
    db.prepare('DELETE FROM candidate_documents WHERE candidate_id=?').run(cid)
    db.prepare('DELETE FROM referrals WHERE candidate_id=?').run(cid)
    const r = db.prepare('DELETE FROM candidates WHERE id=?').run(cid)
    db.exec('COMMIT')
    return r.changes ? { ok: true } : { ok: false, error: '求職者が見つかりません' }
  } catch (e) { db.exec('ROLLBACK'); throw e }
}

export function saveConditions(db, id, criteria) {
  const keep = { ...criteria }
  delete keep.excludeKeys; delete keep.jobKeys
  db.prepare('UPDATE candidates SET conditions_json=?, updated_at=? WHERE id=?').run(JSON.stringify(keep), now(), Number(id))
}

// ---------------- 書類 ----------------
export function addDocument(db, candidateId, { kind, filename, masked_text, pages }, user) {
  const k = ['resume', 'cv', 'other'].includes(kind) ? kind : 'other'
  const r = db.prepare(`INSERT INTO candidate_documents (candidate_id, kind, filename, masked_text, pages, chars, created_by_name) VALUES (?,?,?,?,?,?,?)`)
    .run(Number(candidateId), k, clean(filename, 120), masked_text, pages ?? null, masked_text.length, user?.name ?? null)
  db.prepare('UPDATE candidates SET updated_at=? WHERE id=?').run(now(), Number(candidateId))
  return Number(r.lastInsertRowid)
}
export function deleteDocument(db, candidateId, docId) {
  const r = db.prepare('DELETE FROM candidate_documents WHERE id=? AND candidate_id=?').run(Number(docId), Number(candidateId))
  return r.changes > 0
}
export function documentsForProfile(db, candidateId) {
  return db.prepare('SELECT id, kind, filename, masked_text FROM candidate_documents WHERE candidate_id=? ORDER BY id').all(Number(candidateId))
}
// 書類とメモの組み合わせが変わったら、経歴を作り直す
export function profileHash(db, candidateId) {
  const docs = db.prepare('SELECT id, chars FROM candidate_documents WHERE candidate_id=? ORDER BY id').all(Number(candidateId))
  const c = db.prepare('SELECT memo FROM candidates WHERE id=?').get(Number(candidateId))
  if (!docs.length) return null
  return crypto.createHash('sha256').update(JSON.stringify([docs, c?.memo || ''])).digest('hex').slice(0, 32)
}
export function saveProfile(db, candidateId, profile, hash) {
  db.prepare('UPDATE candidates SET profile_json=?, profile_hash=?, profile_updated_at=? WHERE id=?').run(JSON.stringify(profile), hash, now(), Number(candidateId))
}

// ---------------- 紹介済み ----------------
export function addReferral(db, candidateId, body, user) {
  const key = String(body.job_key || '').trim()
  if (!/^[a-z]+:.+/.test(key)) return { ok: false, error: '求人の指定が正しくありません' }
  db.prepare(`INSERT INTO referrals (candidate_id, job_key, title, company, note, search_id, created_by_name) VALUES (?,?,?,?,?,?,?)
    ON CONFLICT(candidate_id, job_key) DO UPDATE SET note=COALESCE(excluded.note, referrals.note)`)
    .run(Number(candidateId), key, clean(body.title, 200), clean(body.company, 100), clean(body.note, 500), clean(body.search_id, 60), user?.name ?? null)
  db.prepare('UPDATE candidates SET updated_at=? WHERE id=?').run(now(), Number(candidateId))
  return { ok: true }
}
export function deleteReferral(db, candidateId, jobKey) {
  return db.prepare('DELETE FROM referrals WHERE candidate_id=? AND job_key=?').run(Number(candidateId), String(jobKey)).changes > 0
}
export function referralKeys(db, candidateId) {
  return db.prepare('SELECT job_key FROM referrals WHERE candidate_id=?').all(Number(candidateId)).map((r) => r.job_key)
}

// ---------------- AI検索 ----------------
function searchRow(r) {
  const s = j(r.summary_json, {}) || {}
  const c = j(r.criteria_json, {}) || {}
  return {
    id: r.id, user_name: r.user_name, status: r.status, usd: r.usd, created_at: r.created_at, finished_at: r.finished_at,
    freeText: c.freeText || '', recommended: s.recommended ?? null, judged: s.judged ?? null, poolSize: s.poolSize ?? null, elapsedSec: s.elapsedSec ?? null,
  }
}

export function createSearch(db, { candidateId, user, criteria, options }) {
  const id = crypto.randomUUID()
  db.prepare(`INSERT INTO ai_searches (id, candidate_id, user_id, user_name, criteria_json, options_json) VALUES (?,?,?,?,?,?)`)
    .run(id, candidateId ? Number(candidateId) : null, user?.id ?? null, user?.name ?? null, JSON.stringify(criteria), JSON.stringify(options || {}))
  return id
}
export function getSearchRaw(db, id) { return db.prepare('SELECT * FROM ai_searches WHERE id=?').get(String(id)) }

export function getSearch(db, id, { withResults = true } = {}) {
  const r = getSearchRaw(db, id)
  if (!r) return null
  const out = {
    id: r.id, candidate_id: r.candidate_id, user_id: r.user_id, user_name: r.user_name, status: r.status, stage: r.stage, message: r.message,
    log: j(r.log_json, []), criteria: j(r.criteria_json, {}), options: j(r.options_json, {}), plan: j(r.plan_json), summary: j(r.summary_json),
    usd: r.usd, error: r.error, created_at: r.created_at, started_at: r.started_at, finished_at: r.finished_at,
  }
  if (r.status === 'queued') {
    out.queuePosition = db.prepare(`SELECT COUNT(*) AS n FROM ai_searches WHERE status IN ('queued','running') AND created_at <= ? AND id != ?`).get(r.created_at, r.id).n + 1
  }
  if (withResults && ['done', 'cancelled', 'error'].includes(r.status)) {
    const rows = db.prepare('SELECT kind, rank, job_key, score, data_json FROM ai_results WHERE search_id=? ORDER BY kind, rank').all(r.id)
    out.recommended = rows.filter((x) => x.kind === 'recommended').map((x) => j(x.data_json))
    out.reference = rows.filter((x) => x.kind === 'reference').map((x) => j(x.data_json))
  }
  return out
}

export function listSearches(db, { candidateId, userId, limit = 50, offset = 0 } = {}) {
  const where = [], args = []
  if (candidateId) { where.push('s.candidate_id=?'); args.push(Number(candidateId)) }
  if (userId) { where.push('s.user_id=?'); args.push(Number(userId)) }
  const w = where.length ? `WHERE ${where.join(' AND ')}` : ''
  const total = db.prepare(`SELECT COUNT(*) AS n FROM ai_searches s ${w}`).get(...args).n
  const items = db.prepare(`SELECT s.*, c.name AS candidate_name FROM ai_searches s LEFT JOIN candidates c ON c.id=s.candidate_id ${w}
      ORDER BY s.created_at DESC LIMIT ? OFFSET ?`).all(...args, Math.min(200, limit), offset)
    .map((r) => ({ ...searchRow(r), candidate_id: r.candidate_id, candidate_name: r.candidate_name }))
  return { total, items }
}

export function nextQueued(db) {
  return db.prepare(`SELECT id FROM ai_searches WHERE status='queued' ORDER BY created_at, rowid LIMIT 1`).get()?.id || null
}
export function markRunning(db, id) {
  db.prepare(`UPDATE ai_searches SET status='running', started_at=?, message='開始しました' WHERE id=? AND status='queued'`).run(now(), id)
}
export function updateProgress(db, id, { stage, message, log, plan }) {
  db.prepare(`UPDATE ai_searches SET stage=COALESCE(?, stage), message=COALESCE(?, message), log_json=COALESCE(?, log_json), plan_json=COALESCE(?, plan_json) WHERE id=?`)
    .run(stage ?? null, message ?? null, log ? JSON.stringify(log) : null, plan ? JSON.stringify(plan) : null, id)
}
export function requestCancel(db, id) {
  const r = getSearchRaw(db, id)
  if (!r) return { ok: false, error: '検索が見つかりません' }
  if (r.status === 'queued') {
    db.prepare(`UPDATE ai_searches SET status='cancelled', finished_at=?, message='開始前に中止しました' WHERE id=?`).run(now(), id)
    return { ok: true }
  }
  if (r.status !== 'running') return { ok: false, error: 'すでに終わっています' }
  db.prepare('UPDATE ai_searches SET cancel_requested=1 WHERE id=?').run(id)
  return { ok: true }
}
export function cancelRequested(db, id) {
  return !!db.prepare('SELECT cancel_requested FROM ai_searches WHERE id=?').get(id)?.cancel_requested
}

// 結果の保存（画面表示に必要な情報だけ残す）
export function slimResult(r) {
  const job = r.job || {}
  return {
    key: `${job.source}:${job.source_job_id}`, job_id: job.id, source: job.source, source_job_id: job.source_job_id, vacancy_no: job.vacancy_no || null,
    title: job.title, company: job.company, locations: job.locations_text, salary_min: job.salary_min, salary_max: job.salary_max,
    employment: job.employment, category: job.job_category, url: job.url, reward: job.reward_text || null,
    features: job.features || [],
    score: r.score, rawScore: r.rawScore, capped: r.capped, eligibility: r.eligibility, angle: r.angle, angleLabel: r.angleLabel || null,
    must: r.must || [], fit: r.fit || '', reason: r.reason || '', concerns: r.concerns || [], checkPoints: r.checkPoints || [],
    duplicates: r.duplicates || [],
  }
}
export function finishSearch(db, id, { status, result, error, usd, summary }) {
  db.exec('BEGIN')
  try {
    db.prepare('DELETE FROM ai_results WHERE search_id=?').run(id)
    const ins = db.prepare('INSERT INTO ai_results (search_id, kind, rank, job_key, job_id, score, data_json) VALUES (?,?,?,?,?,?,?)')
    for (const [kind, list] of [['recommended', result?.recommended || []], ['reference', result?.reference || []]]) {
      list.forEach((r, i) => { const s = slimResult(r); ins.run(id, kind, i + 1, s.key, s.job_id ?? null, s.score ?? null, JSON.stringify(s)) })
    }
    db.prepare(`UPDATE ai_searches SET status=?, finished_at=?, summary_json=?, plan_json=COALESCE(?, plan_json), usd=?, error=?, stage='done' WHERE id=?`)
      .run(status, now(), summary ? JSON.stringify(summary) : null, result?.plan ? JSON.stringify(result.plan) : null, usd ?? null, error ?? null, id)
    db.exec('COMMIT')
  } catch (e) { db.exec('ROLLBACK'); throw e }
}

// サーバーが止まって途中のまま残った検索を「中断」にする（起動時）
export function recoverInterrupted(db) {
  return db.prepare(`UPDATE ai_searches SET status='error', error='サーバーの再起動で中断されました。もう一度実行してください', finished_at=? WHERE status='running'`).run(now()).changes
}
