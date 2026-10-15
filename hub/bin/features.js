#!/usr/bin/env node
// 既存の全求人に「働き方タグ」（リモート・フレックス・副業可など）を付け直す
//   node --no-warnings bin/features.js
//   ・同期中は実行しない（二重起動防止のロックを共有）
//   ・38万件で数分。検索はその間も使える
import fs from 'node:fs'
import path from 'node:path'
import { openDb } from '../lib/db.js'
import { config } from '../lib/env.js'
import { backfillFeatures } from '../lib/backfill.js'
import { FEATURES } from '../lib/features.js'

const cfg = config()
const lock = path.join(path.dirname(cfg.dbPath), 'sync.lock')
if (fs.existsSync(lock)) {
  const pid = parseInt(fs.readFileSync(lock, 'utf8'), 10)
  try { process.kill(pid, 0); console.error(`同期が実行中です（pid=${pid}）。終わってから実行してください`); process.exit(1) } catch {}
}
fs.writeFileSync(lock, String(process.pid))
const t0 = Date.now()
try {
  const db = openDb(cfg.dbPath)
  const r = backfillFeatures(db, { log: (m) => console.log(m) })
  db.close()
  console.log(`完了: ${r.total.toLocaleString()} 件（${Math.round((Date.now() - t0) / 1000)}秒）`)
  for (const [k, label] of Object.entries(FEATURES)) console.log(`  ${label.padEnd(12)} ${(r.counts[k] || 0).toLocaleString()} 件`)
} finally {
  try { fs.unlinkSync(lock) } catch {}
}
