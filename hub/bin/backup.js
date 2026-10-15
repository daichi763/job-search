#!/usr/bin/env node
// ============================================================
// ハブDBのバックアップ（同期の後に毎日実行）
//   ・稼働中でも安全な SQLite のオンラインバックアップで複製 → 壊れていないか確認 → gzip 圧縮
//   ・古いものは HUB_BACKUP_KEEP 世代（既定3）を残して削除
//   node --no-warnings bin/backup.js
// ============================================================
import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'
import { pipeline } from 'node:stream/promises'
import { DatabaseSync, backup } from 'node:sqlite'
import { config } from '../lib/env.js'

const cfg = config()
const ts = () => new Date().toLocaleString('ja-JP', { hour12: false })
const log = (m) => console.log(`[${ts()}] ${m}`)

async function main() {
  if (!fs.existsSync(cfg.dbPath)) throw new Error(`DBがありません: ${cfg.dbPath}`)
  fs.mkdirSync(cfg.backupDir, { recursive: true, mode: 0o700 })
  const d = new Date()
  const stamp = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}_${String(d.getHours()).padStart(2, '0')}${String(d.getMinutes()).padStart(2, '0')}`
  const tmp = path.join(cfg.backupDir, `jobs_hub_${stamp}.sqlite`)
  const out = `${tmp}.gz`

  // 空き容量の確認（DBの1.5倍は必要）
  const need = fs.statSync(cfg.dbPath).size * 1.5
  const st = fs.statfsSync(cfg.backupDir)
  if (st.bavail * st.bsize < need) throw new Error(`空き容量が不足しています（必要 約${(need / 1e9).toFixed(1)}GB）`)

  const t0 = Date.now()
  const src = new DatabaseSync(cfg.dbPath, { readOnly: true })
  await backup(src, tmp, { rate: 2000 })
  src.close()
  // 複製を単一ファイル形式に戻す（-wal/-shm の付属ファイルを残さない）
  const chk = new DatabaseSync(tmp)
  chk.exec('PRAGMA journal_mode = DELETE')
  const ok = chk.prepare('PRAGMA quick_check').get()
  const n = chk.prepare('SELECT COUNT(*) AS n FROM jobs').get().n
  chk.close()
  for (const ext of ['-wal', '-shm']) { try { fs.unlinkSync(tmp + ext) } catch {} }
  const okVal = Object.values(ok)[0]
  if (okVal !== 'ok') { fs.unlinkSync(tmp); throw new Error(`バックアップの検証に失敗: ${okVal}`) }

  await pipeline(fs.createReadStream(tmp), zlib.createGzip({ level: 6 }), fs.createWriteStream(out, { mode: 0o600 }))
  fs.unlinkSync(tmp)
  log(`バックアップ完了: ${out}（${(fs.statSync(out).size / 1e6).toFixed(0)} MB / 求人 ${n.toLocaleString()} 件 / ${Math.round((Date.now() - t0) / 1000)}秒）`)

  // 古い世代を削除
  const files = fs.readdirSync(cfg.backupDir).filter((f) => /^jobs_hub_.*\.sqlite\.gz$/.test(f)).sort().reverse()
  for (const f of files.slice(cfg.backupKeep)) {
    fs.unlinkSync(path.join(cfg.backupDir, f))
    log(`古いバックアップを削除: ${f}`)
  }
  // 作業用DB（求職者・書類・検索結果）も同じ場所に保存（小さいので7世代残す）
  const wsPath = process.env.HUB_WORKSPACE_PATH || path.join(path.dirname(cfg.dbPath), 'workspace.sqlite')
  if (fs.existsSync(wsPath)) {
    const wtmp = path.join(cfg.backupDir, `workspace_${stamp}.sqlite`)
    const wsrc = new DatabaseSync(wsPath, { readOnly: true })
    await backup(wsrc, wtmp)
    wsrc.close()
    const wchk = new DatabaseSync(wtmp); wchk.exec('PRAGMA journal_mode = DELETE')
    const wn = wchk.prepare('SELECT COUNT(*) AS n FROM candidates').get().n; wchk.close()
    for (const ext of ['-wal', '-shm']) { try { fs.unlinkSync(wtmp + ext) } catch {} }
    await pipeline(fs.createReadStream(wtmp), zlib.createGzip({ level: 6 }), fs.createWriteStream(`${wtmp}.gz`, { mode: 0o600 }))
    fs.unlinkSync(wtmp)
    log(`作業用DBのバックアップ完了: ${wtmp}.gz（求職者 ${wn.toLocaleString()} 人）`)
    const wfiles = fs.readdirSync(cfg.backupDir).filter((f) => /^workspace_.*\.sqlite\.gz$/.test(f)).sort().reverse()
    for (const f of wfiles.slice(7)) fs.unlinkSync(path.join(cfg.backupDir, f))
  }
  // 途中で失敗して残った未圧縮ファイルを掃除
  for (const f of fs.readdirSync(cfg.backupDir).filter((f) => /^(jobs_hub|workspace)_.*\.sqlite(-wal|-shm)?$/.test(f))) {
    fs.unlinkSync(path.join(cfg.backupDir, f))
  }
}
main().catch((e) => { log(`バックアップ失敗: ${e.message}`); process.exit(1) })
