#!/usr/bin/env node
// ============================================================
// AI検索サーバー（PM2: hub-ai。127.0.0.1:3101 のサーバー内部専用）
//   ・画面（webapp の /ai）から中継されて使う。直接は公開しない
//   ・webapp との合言葉: worker/.env または hub/.env の INGEST_TOKEN（.dev.vars と同じ値）
//   ・ログインした担当者は webapp が x-hub-user ヘッダ（base64 の JSON）で渡す
//   ・作業データ（求職者・書類・紹介済み・検索結果）は hub/data/workspace.sqlite
//   node --no-warnings bin/ai-server.js
// ============================================================
import http from 'node:http'
import path from 'node:path'
import fs from 'node:fs'
import crypto from 'node:crypto'
import { openDb } from '../lib/db.js'
import { config, loadEnv, HUB_DIR } from '../lib/env.js'
import { openWorkspace } from '../lib/workspace.js'
import { createService } from '../lib/ai/service.js'

const env = loadEnv()
const cfg = config()
const PORT = parseInt(env.HUB_AI_PORT || '3101', 10)
const HOST = '127.0.0.1'
const TOKEN = env.HUB_AI_TOKEN || env.INGEST_TOKEN || ''
const WS_PATH = env.HUB_WORKSPACE_PATH || path.join(HUB_DIR, 'data', 'workspace.sqlite')
const MAX_BODY = 12 * 1024 * 1024

if (!TOKEN) { console.error('INGEST_TOKEN（または HUB_AI_TOKEN）が設定されていません。worker/.env を確認してください。'); process.exit(1) }
if (!env.HUB_AI_API_KEY && !env.OPENAI_API_KEY) { console.error('OpenAI のAPIキー（OPENAI_API_KEY）が設定されていません。worker/.env を確認してください。'); process.exit(1) }
if (!fs.existsSync(cfg.dbPath)) { console.error(`求人DBがありません: ${cfg.dbPath}`); process.exit(1) }

let jobsDb = openDb(cfg.dbPath, { readonly: true })
const ws = openWorkspace(WS_PATH)
const svc = createService({ env, jobsDb: () => jobsDb, ws, log: (m) => console.log(new Date().toISOString(), m) })

const safeEq = (a, b) => { const x = Buffer.from(String(a)), y = Buffer.from(String(b)); return x.length === y.length && crypto.timingSafeEqual(x, y) }
function send(res, code, body) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' })
  res.end(JSON.stringify(body))
}

const server = http.createServer(async (req, res) => {
  try {
    if (!safeEq(req.headers['x-hub-token'] || '', TOKEN)) return send(res, 401, { ok: false, error: 'unauthorized' })
    let user = null
    try { user = req.headers['x-hub-user'] ? JSON.parse(Buffer.from(String(req.headers['x-hub-user']), 'base64').toString('utf8')) : null } catch {}
    const url = new URL(req.url, 'http://x')
    let body = {}
    if (!['GET', 'HEAD'].includes(req.method)) {
      let size = 0; const chunks = []
      for await (const c of req) { size += c.length; if (size > MAX_BODY) return send(res, 413, { ok: false, error: 'ファイルが大きすぎます' }); chunks.push(c) }
      if (chunks.length) { try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')) } catch { return send(res, 400, { ok: false, error: 'JSONが読めません' }) } }
    }
    const r = await svc.handle({ method: req.method, path: url.pathname.replace(/^\/ai/, '') || '/', query: url.searchParams, body, user })
    return send(res, r.status, r.body)
  } catch (e) {
    console.error(new Date().toISOString(), req.method, req.url, e.stack || e.message)
    if (/database|disk|malformed/i.test(e.message)) { try { jobsDb.close() } catch {}; jobsDb = openDb(cfg.dbPath, { readonly: true }) }
    return send(res, 500, { ok: false, error: '処理中にエラーが発生しました' })
  }
})
server.listen(PORT, HOST, () => console.log(`AI検索サーバー: http://${HOST}:${PORT}/（サーバー内部専用） 作業DB=${WS_PATH}`))
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { server.close(); svc.close(); try { ws.close() } catch {}; try { jobsDb.close() } catch {}; process.exit(0) })
