// ============================================================
// 同期エンジン（媒体に依存しない共通処理）
//
//   毎回「媒体の一覧を全件読む」→ DBと比べて、変わったものだけ書き込む。
//     ・新しい求人            → 追加（added）
//     ・内容が変わった          → 更新（updated）。変わった項目名を履歴に残す
//     ・内容は同じで媒体の更新日時/元データだけ変わった → 軽い更新（refreshed）
//     ・変わらない            → 何もしない（unchanged）
//     ・掲載終了だったものが再び出た → 再掲載（reopened）
//     ・一覧に無かった          → 連続 N 回で掲載終了（closed）
//     ・掲載終了から一定時間経過   → 物理削除（deleted）
//
//   掲載終了の安全装置（8月の同期失敗の再発防止）
//     ・最後まで読み切れなかった回（ページ取得失敗・時間切れ・取得数不足）は判定しない
//     ・1回で媒体全体の一定割合を超えて消えたら判定を保留する
//     ・ページ送り中に順番がずれて読み飛ばすことがあるため、既定で2回連続で無い場合のみ終了
// ============================================================
import { tx, nowIso } from './db.js'
import { normalizeJob, ftsColumns, CONTENT_FIELDS } from './normalize.js'

const JOB_COLS = [
  'title', 'company', 'company_url', 'job_category', 'job_categories_json', 'industry', 'industries_json',
  'employment', 'locations_text', 'salary_min', 'salary_max', 'age_min', 'age_max', 'gender', 'education',
  'overtime', 'holiday', 'experience_json', 'positions_json', 'career_stage',
  'reward_type', 'reward_rate', 'reward_amount', 'reward_text', 'url',
  'source_published_at', 'source_updated_at', 'content_hash',
]

export class SyncSession {
  constructor(db, { source, runId, cfg, authoritative = false, log = () => {} }) {
    this.db = db
    this.source = source
    this.runId = runId
    this.cfg = cfg
    // authoritative=true: 1回の取得で全件を確実に読める媒体（kintone等）→ 1回の欠落で掲載終了
    this.closeAfter = authoritative ? 1 : cfg.closeAfterMisses
    this.log = log
    this.seen = new Set()
    this.stats = { fetched: 0, added: 0, updated: 0, refreshed: 0, unchanged: 0, reopened: 0, duplicates: 0, invalid: 0 }
    this._prepare()
    this._loadExisting()
  }

  _prepare() {
    const db = this.db
    const cols = JOB_COLS.join(', ')
    const ph = JOB_COLS.map(() => '?').join(', ')
    this.st = {
      insJob: db.prepare(`INSERT INTO jobs (source, source_job_id, status, ${cols}, first_seen_at, last_changed_at)
                          VALUES (?, ?, 'open', ${ph}, ?, ?) RETURNING id`),
      updJob: db.prepare(`UPDATE jobs SET ${JOB_COLS.map((c) => `${c}=?`).join(', ')},
                          status='open', closed_at=NULL, miss_count=0, last_changed_at=?, version=version+1
                          WHERE id=?`),
      reopen: db.prepare(`UPDATE jobs SET status='open', closed_at=NULL, miss_count=0, source_updated_at=? WHERE id=?`),
      refresh: db.prepare(`UPDATE jobs SET source_updated_at=? WHERE id=?`),
      getOld: db.prepare(`SELECT j.*, t.description, t.requirements, t.benefits,
                            (SELECT json_group_array(prefecture) FROM job_prefectures p WHERE p.job_id=j.id) AS prefs
                          FROM jobs j LEFT JOIN job_texts t ON t.job_id=j.id WHERE j.id=?`),
      upText: db.prepare(`INSERT INTO job_texts(job_id, description, requirements, benefits) VALUES (?,?,?,?)
                          ON CONFLICT(job_id) DO UPDATE SET description=excluded.description,
                          requirements=excluded.requirements, benefits=excluded.benefits`),
      upRaw: db.prepare(`INSERT INTO job_raw(job_id, raw_json, raw_hash, fetched_at) VALUES (?,?,?,?)
                         ON CONFLICT(job_id) DO UPDATE SET raw_json=excluded.raw_json,
                         raw_hash=excluded.raw_hash, fetched_at=excluded.fetched_at`),
      delPref: db.prepare(`DELETE FROM job_prefectures WHERE job_id=?`),
      insPref: db.prepare(`INSERT OR IGNORE INTO job_prefectures(job_id, prefecture) VALUES (?,?)`),
      delFts: db.prepare(`DELETE FROM jobs_fts WHERE rowid=?`),
      insFts: db.prepare(`INSERT INTO jobs_fts(rowid, head, body) VALUES (?,?,?)`),
      change: db.prepare(`INSERT INTO job_changes(job_id, source, source_job_id, change_type, changed_fields, sync_run_id, changed_at)
                          VALUES (?,?,?,?,?,?,?)`),
    }
  }

  // この媒体の既存求人を読み込む（比較用。数十万件でも数十MB程度）
  _loadExisting() {
    this.existing = new Map()
    const rows = this.db.prepare(
      `SELECT j.id, j.source_job_id, j.status, j.content_hash, j.source_updated_at, j.miss_count, r.raw_hash
       FROM jobs j LEFT JOIN job_raw r ON r.job_id=j.id WHERE j.source=?`).all(this.source)
    for (const r of rows) this.existing.set(r.source_job_id, r)
    this.log(`既存 ${this.existing.size.toLocaleString()} 件を読み込み`)
  }

  // 1ページ分（媒体の生データ＋mapApiJob済み）を取り込む
  //   items: [{ mapped, raw }]
  ingest(items) {
    const now = nowIso()
    const recs = []
    for (const it of items) {
      const rec = normalizeJob(this.source, it.mapped, it.raw)
      if (!rec) { this.stats.invalid++; continue }
      if (this.seen.has(rec.source_job_id)) { this.stats.duplicates++; continue } // ページずれによる重複
      this.seen.add(rec.source_job_id)
      this.stats.fetched++
      recs.push(rec)
    }
    if (!recs.length) return
    tx(this.db, () => {
      for (const rec of recs) this._apply(rec, now)
    })
  }

  _writeDetails(id, rec, now) {
    const s = this.st
    s.upText.run(id, rec.description, rec.requirements, rec.benefits)
    s.upRaw.run(id, rec.raw_json, rec.raw_hash, now)
    s.delPref.run(id)
    for (const p of rec.prefectures) s.insPref.run(id, p)
    const f = ftsColumns(rec)
    s.delFts.run(id)
    s.insFts.run(id, f.head, f.body)
  }

  _apply(rec, now) {
    const s = this.st
    const old = this.existing.get(rec.source_job_id)
    const vals = JOB_COLS.map((c) => rec[c] ?? null)

    if (!old) {
      const { id } = s.insJob.get(this.source, rec.source_job_id, ...vals, now, now)
      this._writeDetails(id, rec, now)
      s.change.run(id, this.source, rec.source_job_id, 'added', null, this.runId, now)
      this.existing.set(rec.source_job_id, { id, status: 'open', content_hash: rec.content_hash, source_updated_at: rec.source_updated_at, miss_count: 0, raw_hash: rec.raw_hash })
      this.stats.added++
      return
    }

    if (old.content_hash !== rec.content_hash) {
      const changed = this._diffFields(old.id, rec)
      s.updJob.run(...vals, now, old.id)
      this._writeDetails(old.id, rec, now)
      s.change.run(old.id, this.source, rec.source_job_id, old.status === 'closed' ? 'reopened' : 'updated',
        JSON.stringify(changed), this.runId, now)
      if (old.status === 'closed') this.stats.reopened++
      else this.stats.updated++
      Object.assign(old, { status: 'open', content_hash: rec.content_hash, source_updated_at: rec.source_updated_at, miss_count: 0, raw_hash: rec.raw_hash })
      return
    }

    if (old.status === 'closed') {
      s.reopen.run(rec.source_updated_at, old.id)
      s.upRaw.run(old.id, rec.raw_json, rec.raw_hash, now)
      s.change.run(old.id, this.source, rec.source_job_id, 'reopened', null, this.runId, now)
      Object.assign(old, { status: 'open', miss_count: 0, source_updated_at: rec.source_updated_at, raw_hash: rec.raw_hash })
      this.stats.reopened++
      return
    }

    // 内容は同じ。媒体の更新日時や元データ（検索用には使わない項目）だけ変わった場合は軽く更新
    if (old.source_updated_at !== rec.source_updated_at || old.raw_hash !== rec.raw_hash) {
      s.refresh.run(rec.source_updated_at, old.id)
      if (old.raw_hash !== rec.raw_hash) s.upRaw.run(old.id, rec.raw_json, rec.raw_hash, now)
      old.source_updated_at = rec.source_updated_at
      old.raw_hash = rec.raw_hash
      this.stats.refreshed++
      return
    }
    this.stats.unchanged++
  }

  // 何が変わったか（履歴用）。更新は全体の一部なので、その時だけ旧データを読む
  _diffFields(id, rec) {
    const o = this.st.getOld.get(id)
    if (!o) return []
    const prefs = JSON.parse(o.prefs || '[]').sort()
    const cmp = { ...o, prefectures: prefs }
    const recCmp = { ...rec, prefectures: [...rec.prefectures].sort() }
    return CONTENT_FIELDS.filter((f) => JSON.stringify(cmp[f] ?? null) !== JSON.stringify(recCmp[f] ?? null))
  }

  // 取得後の後処理: 掲載終了の判定（安全装置つき）
  //   complete: 最後まで読み切れたか / remoteTotal: 媒体の総件数
  finalize({ complete, remoteTotal, reason }) {
    const now = nowIso()
    const res = { missing: 0, closed: 0, complete: !!complete, note: null }
    const db = this.db
    const openRows = [...this.existing.entries()].filter(([, r]) => r.status === 'open')
    const missing = openRows.filter(([sid]) => !this.seen.has(sid)).map(([sid, r]) => ({ sid, r }))
    res.missing = missing.length

    tx(db, () => {
      // 今回見つかった求人の「連続欠落回数」をリセット（0でないものだけ書く）
      const reset = db.prepare(`UPDATE jobs SET miss_count=0 WHERE id=?`)
      for (const [sid, r] of this.existing.entries()) {
        if (r.miss_count > 0 && this.seen.has(sid)) { reset.run(r.id); r.miss_count = 0 }
      }

      if (!complete) {
        res.note = `読み切れなかったため掲載終了の判定をしませんでした（${reason || '理由不明'}）`
        return
      }
      const base = Math.max(remoteTotal || 0, openRows.length, 1)
      if (missing.length / base > this.cfg.maxCloseRatio) {
        res.note = `一覧に無い求人が ${missing.length.toLocaleString()} 件（全体の${(missing.length / base * 100).toFixed(1)}%）で上限 ${(this.cfg.maxCloseRatio * 100).toFixed(0)}% を超えたため、判定を保留しました`
        return
      }
      const inc = db.prepare(`UPDATE jobs SET miss_count=miss_count+1 WHERE id=?`)
      const close = db.prepare(`UPDATE jobs SET status='closed', closed_at=?, miss_count=? WHERE id=?`)
      const change = this.st.change
      for (const { sid, r } of missing) {
        const n = r.miss_count + 1
        if (n >= this.closeAfter) {
          close.run(now, n, r.id)
          change.run(r.id, this.source, sid, 'closed', null, this.runId, now)
          r.status = 'closed'
          res.closed++
        } else {
          inc.run(r.id)
        }
        r.miss_count = n
      }
    })
    return res
  }
}

// 掲載終了から一定時間たった求人を物理削除し、古い変更履歴を整理する（全媒体共通）
export function purge(db, cfg, runId = null) {
  const now = nowIso()
  const limit = new Date(Date.now() - cfg.deleteAfterHours * 3600 * 1000).toISOString()
  const targets = db.prepare(`SELECT id, source, source_job_id FROM jobs WHERE status='closed' AND closed_at <= ?`).all(limit)
  const bySource = {}
  tx(db, () => {
    const delFts = db.prepare(`DELETE FROM jobs_fts WHERE rowid=?`)
    const delJob = db.prepare(`DELETE FROM jobs WHERE id=?`) // job_texts/job_raw/job_prefectures は連動して消える
    const change = db.prepare(`INSERT INTO job_changes(job_id, source, source_job_id, change_type, sync_run_id, changed_at)
                               VALUES (?,?,?,'deleted',?,?)`)
    for (const t of targets) {
      delFts.run(t.id)
      delJob.run(t.id)
      change.run(t.id, t.source, t.source_job_id, runId, now)
      bySource[t.source] = (bySource[t.source] || 0) + 1
    }
    const keep = new Date(Date.now() - cfg.changeLogDays * 86400 * 1000).toISOString()
    db.prepare(`DELETE FROM job_changes WHERE changed_at < ?`).run(keep)
  })
  return bySource
}
