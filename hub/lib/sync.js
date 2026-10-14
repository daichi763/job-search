// ============================================================
// 同期の実行（複数媒体を並列に。媒体ごとに記録を残す）
// ============================================================
import fs from 'node:fs'
import path from 'node:path'
import { openDb, nowIso } from './db.js'
import { SyncSession, purge } from './engine.js'
import { DRIVERS } from './drivers.js'
import { config, loadEnv, workerRequire } from './env.js'

// 「HH:MM」→ 開始時刻以降で最初に来るその時刻
export function nextDeadline(hhmm, from = new Date()) {
  if (!hhmm || hhmm === 'none') return null
  const [h, m] = hhmm.split(':').map((x) => parseInt(x, 10))
  const d = new Date(from)
  d.setHours(h, m || 0, 0, 0)
  if (d <= from) d.setDate(d.getDate() + 1)
  return d
}

// 二重起動防止（同期中に cron や手動で再実行されても重ならない）
function acquireLock(dir) {
  const file = path.join(dir, 'sync.lock')
  fs.mkdirSync(dir, { recursive: true })
  if (fs.existsSync(file)) {
    const pid = parseInt(fs.readFileSync(file, 'utf8'), 10)
    let alive = false
    try { if (pid) { process.kill(pid, 0); alive = true } } catch {}
    if (alive) throw new Error(`別の同期が実行中です（pid=${pid}）`)
  }
  fs.writeFileSync(file, String(process.pid))
  return () => { try { fs.unlinkSync(file) } catch {} }
}

// 既存アプリでAI検索が実行中なら待つ（circus/ヒトリンクの同時ログイン競合を避ける）
async function waitForAiIdle(appUrl, log, maxMinutes = 30) {
  for (let i = 0; i < maxMinutes * 2; i++) {
    try {
      const r = await fetch(`${appUrl}/api/search/active`, { signal: AbortSignal.timeout(5000) })
      const j = await r.json()
      if (!j || !j.active) return true
      if (i === 0) log(`AI検索が実行中のため待機します（searchJobId=${j.searchJobId}）`)
    } catch {
      return true // 既存アプリに繋がらない場合は待たない
    }
    await new Promise((r) => setTimeout(r, 30000))
  }
  return false
}

export async function runSync({ sources, trigger = 'manual', deadline, log = console.log } = {}) {
  const cfg = config()
  const env = loadEnv()
  const unknown = sources.filter((s) => !DRIVERS[s])
  if (unknown.length) throw new Error(`未対応の媒体: ${unknown.join(', ')}（対応: ${Object.keys(DRIVERS).join(', ')}）`)

  const release = acquireLock(path.dirname(cfg.dbPath))
  const db = openDb(cfg.dbPath)
  const startedAt = new Date()
  const dl = nextDeadline(deadline ?? cfg.deadline, startedAt)
  const shouldStop = () => dl != null && Date.now() >= dl.getTime()
  log(`同期開始 媒体=[${sources.join(', ')}] 打ち切り時刻=${dl ? dl.toLocaleString('ja-JP') : 'なし'} DB=${cfg.dbPath}`)

  let browser = null
  const results = {}
  try {
    const needBrowser = sources.some((s) => DRIVERS[s].needsBrowser)
    if (needBrowser) {
      const idle = await waitForAiIdle(cfg.appUrl, log)
      if (!idle) throw new Error('AI検索が30分以上終わらないため、同期を中止しました')
      const { chromium } = workerRequire('playwright')
      browser = await chromium.launch({ headless: cfg.headless })
    }

    await Promise.all(sources.map(async (source) => {
      const drv = DRIVERS[source]
      const slog = (msg) => log(`[${source}] ${msg}`)
      const t0 = Date.now()
      const runId = Number(db.prepare(`INSERT INTO sync_runs(source, trigger, status, started_at) VALUES (?,?, 'running', ?)`)
        .run(source, trigger, nowIso()).lastInsertRowid)
      const session = new SyncSession(db, { source, runId, cfg, authoritative: drv.authoritative, log: slog })
      let out = null, err = null
      try {
        out = await drv.run({ cfg, env, browser, log: slog, shouldStop, session, onPage: (items) => session.ingest(items) })
      } catch (e) {
        err = e
        slog(`エラー: ${e.message}`)
      }
      const fin = session.finalize({
        complete: !err && out?.complete,
        remoteTotal: out?.remoteTotal,
        reason: err ? `エラー: ${err.message}` : out?.reason,
      })
      const st = session.stats
      const status = err ? (st.fetched ? 'partial' : 'error') : (fin.complete ? 'done' : 'partial')
      db.prepare(`UPDATE sync_runs SET status=?, finished_at=?, remote_total=?, fetched=?, pages_ok=?, pages_failed=?,
                  added=?, updated=?, refreshed=?, unchanged=?, reopened=?, missing=?, closed=?, complete=?,
                  close_note=?, error=?, duration_sec=? WHERE id=?`)
        .run(status, nowIso(), out?.remoteTotal ?? null, st.fetched, out?.pagesOk ?? 0, out?.pagesFailed ?? 0,
          st.added, st.updated, st.refreshed, st.unchanged, st.reopened, fin.missing, fin.closed, fin.complete ? 1 : 0,
          fin.note, err ? String(err.message).slice(0, 500) : null, Math.round((Date.now() - t0) / 1000), runId)
      results[source] = { status, remoteTotal: out?.remoteTotal ?? null, ...st, missing: fin.missing, closed: fin.closed, note: fin.note, error: err?.message }
      if (out?.pagesRecovered) slog(`取り直しで回復したページ: ${out.pagesRecovered}`)
      slog(`${status}: 取得${st.fetched} 追加${st.added} 更新${st.updated} 軽更新${st.refreshed} 変化なし${st.unchanged} 再掲載${st.reopened} 一覧に無し${fin.missing} 掲載終了${fin.closed}${fin.note ? ' / ' + fin.note : ''}`)
    }))

    const deleted = purge(db, cfg)
    const delTotal = Object.values(deleted).reduce((a, b) => a + b, 0)
    if (delTotal) log(`掲載終了から${cfg.deleteAfterHours}時間を過ぎた求人を削除: ${JSON.stringify(deleted)}`)
    for (const [s, n] of Object.entries(deleted)) {
      db.prepare(`UPDATE sync_runs SET deleted=? WHERE id=(SELECT MAX(id) FROM sync_runs WHERE source=?)`).run(n, s)
      if (results[s]) results[s].deleted = n
    }
    db.exec('PRAGMA optimize')
    try { db.exec(`INSERT INTO jobs_fts(jobs_fts) VALUES('optimize')`) } catch {}
  } finally {
    if (browser) await browser.close().catch(() => {})
    db.close()
    release()
  }
  log(`同期終了 所要 ${Math.round((Date.now() - startedAt.getTime()) / 60000)} 分`)
  return results
}
