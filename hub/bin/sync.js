#!/usr/bin/env node
// ============================================================
// 同期の実行
//   node --no-warnings bin/sync.js kintone hitolink          # 媒体を指定
//   node --no-warnings bin/sync.js --all --trigger=cron       # 対応している全媒体（cron用）
//   オプション:
//     --deadline=05:00   この時刻で取得を打ち切る（既定: hub/.env の HUB_SYNC_DEADLINE、未設定なら 05:00）
//     --deadline=none    打ち切らない（手動テスト用）
// ============================================================
import { runSync } from '../lib/sync.js'
import { DRIVERS } from '../lib/drivers.js'

const args = process.argv.slice(2)
const opt = (k) => { const a = args.find((x) => x.startsWith(`--${k}=`)); return a ? a.split('=').slice(1).join('=') : undefined }
const sources = args.includes('--all') ? Object.keys(DRIVERS) : args.filter((a) => !a.startsWith('--'))
if (!sources.length) {
  console.error(`使い方: node --no-warnings bin/sync.js <媒体...> | --all\n対応媒体: ${Object.keys(DRIVERS).join(', ')}`)
  process.exit(2)
}
const ts = () => new Date().toLocaleString('ja-JP', { hour12: false })
const log = (m) => console.log(`[${ts()}] ${m}`)

runSync({ sources, trigger: opt('trigger') || 'manual', deadline: opt('deadline'), log })
  .then((r) => {
    const bad = Object.values(r).some((x) => x.status === 'error')
    process.exit(bad ? 1 : 0)
  })
  .catch((e) => { log(`中止: ${e.message}`); process.exit(1) })
