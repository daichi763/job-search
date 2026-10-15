#!/usr/bin/env node
// ============================================================
// 求人データハブの閲覧画面＋読み取り用API（DBは読み取り専用で開く）
//
//   node --no-warnings bin/server.js   （PM2 では ecosystem.config.cjs の hub-api）
//   ・既定は 127.0.0.1（サーバー内部専用）で起動し、既存アプリ（3000番）の /manual・/hub-api から中継して使う
//   ・外部に直接公開する場合（HUB_HOST=0.0.0.0）はベーシック認証が必須
//     ID/パスワードは hub/.env の HUB_VIEWER_USER / HUB_VIEWER_PASSWORD
//   ・同期中も見られる（DBは同期中も読み取りできる形式で動いている）
//
//   API（段階3の検索APIの土台。今は画面から使うだけ）
//     GET /api/overview            媒体別件数・最終同期・都道府県一覧
//     GET /api/jobs?keyword=...    検索（条件は lib/search.js 参照）
//     GET /api/jobs/:id            求人の詳細（文章・元データ・変更履歴）
// ============================================================
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { openDb } from '../lib/db.js'
import { config, loadEnv, HUB_DIR } from '../lib/env.js'
import { searchJobs, getJob, getOverview } from '../lib/search.js'
import { handleApiV1 } from '../lib/api.js'

const env = loadEnv()
const cfg = config()
const PORT = parseInt(env.HUB_PORT || '3100', 10)
// 既定は「このサーバー内からだけ接続できる」127.0.0.1。外からは既存アプリ（3000番）経由で使う。
const HOST = env.HUB_HOST || '127.0.0.1'
const LOOPBACK = ['127.0.0.1', 'localhost', '::1'].includes(HOST)
const USER = env.HUB_VIEWER_USER || 'admin'
const PASS = env.HUB_VIEWER_PASSWORD || ''
// 外部に直接公開する設定（HUB_HOST=0.0.0.0 など）のときはパスワード必須
if (!LOOPBACK && (!PASS || PASS.length < 8)) {
  console.error('HUB_HOST を外部公開にする場合は hub/.env に HUB_VIEWER_PASSWORD（8文字以上）を設定してください。')
  process.exit(1)
}
const AUTH_REQUIRED = !!PASS
// 外部向けAPI（/api/v1）のAPIキー（任意）。カンマ区切りで複数可。未設定なら鍵なしで使える
const API_KEYS = (env.HUB_API_KEYS || '').split(',').map((s) => s.trim()).filter(Boolean)
const apiKeyOk = (req, url) => {
  if (!API_KEYS.length) return true
  const h = req.headers.authorization || ''
  const key = req.headers['x-api-key'] || (h.startsWith('Bearer ') ? h.slice(7) : '')
  return API_KEYS.some((k) => safeEq(k, key))
}
// 簡易の回数制限（同じ接続元から1分あたり HUB_API_RATE 回まで。既定 300）
const RATE = parseInt(env.HUB_API_RATE || '300', 10)
const hits = new Map()
function rateOk(id) {
  const now = Date.now(), h = hits.get(id)
  if (!h || now - h.t > 60000) { hits.set(id, { t: now, n: 1 }); if (hits.size > 10000) hits.clear(); return true }
  return ++h.n <= RATE
}
if (!fs.existsSync(cfg.dbPath)) {
  console.error(`DBがありません: ${cfg.dbPath}`)
  process.exit(1)
}

let db = openDb(cfg.dbPath, { readonly: true })
const PAGE = fs.readFileSync(path.join(HUB_DIR, 'public', 'index.html'))

const safeEq = (a, b) => {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b))
  return x.length === y.length && crypto.timingSafeEqual(x, y)
}
function authorized(req) {
  const h = req.headers.authorization || ''
  if (!h.startsWith('Basic ')) return false
  const [u, ...p] = Buffer.from(h.slice(6), 'base64').toString().split(':')
  return safeEq(u, USER) & safeEq(p.join(':'), PASS)
}

// ログイン失敗が続く相手は一時的に締め出す（総当たり対策）
const fails = new Map()
const blocked = (ip) => (fails.get(ip)?.n || 0) >= 10 && Date.now() - fails.get(ip).t < 15 * 60 * 1000

function send(res, code, body, type = 'application/json; charset=utf-8', extra = {}) {
  res.writeHead(code, {
    ...extra,
    'Content-Type': type,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'no-referrer',
  })
  res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body))
}

const server = http.createServer((req, res) => {
  const ip = req.socket.remoteAddress
  if (blocked(ip)) return send(res, 429, { error: 'too_many_attempts' })
  if (req.url === '/favicon.ico') { res.writeHead(204); return res.end() }

  // ---- 外部向け検索API v1（別アプリ用。画面用のログインとは別にAPIキーで管理）----
  if (req.url.startsWith('/api/v1/')) {
    const cors = { 'Access-Control-Allow-Origin': env.HUB_API_CORS_ORIGIN || '*', 'Access-Control-Allow-Headers': 'Authorization, X-API-Key', 'Access-Control-Allow-Methods': 'GET, OPTIONS' }
    if (req.method === 'OPTIONS') { res.writeHead(204, cors); return res.end() }
    if (req.method !== 'GET') return send(res, 405, { error: { code: 'method_not_allowed', message: 'GET のみ使えます' } }, undefined, cors)
    const url = new URL(req.url, 'http://x')
    if (!apiKeyOk(req, url)) return send(res, 401, { error: { code: 'unauthorized', message: 'APIキーが正しくありません' } }, undefined, cors)
    const who = req.headers['x-forwarded-for']?.split(',')[0].trim() || ip
    if (!rateOk(who)) return send(res, 429, { error: { code: 'rate_limited', message: `1分あたり${RATE}回までです` } }, undefined, { ...cors, 'Retry-After': '60' })
    const t0 = performance.now()
    try {
      const r = handleApiV1(db, url.pathname, url.searchParams)
      const ms = Math.round(performance.now() - t0)
      if (r.status === 200 && r.body.meta) r.body.meta.took_ms = ms
      return send(res, r.status, r.body, undefined, { ...cors, 'X-Response-Time': `${ms}ms` })
    } catch (e) {
      console.error(new Date().toISOString(), req.url, e.message)
      if (/database|disk|malformed/i.test(e.message)) { try { db.close() } catch {}; db = openDb(cfg.dbPath, { readonly: true }) }
      return send(res, 500, { error: { code: 'internal_error', message: '検索中にエラーが発生しました' } }, undefined, cors)
    }
  }
  if (AUTH_REQUIRED && !authorized(req)) {
    if (req.headers.authorization) {
      const f = fails.get(ip) || { n: 0, t: 0 }
      fails.set(ip, { n: f.n + 1, t: Date.now() })
    }
    res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="job-hub", charset="UTF-8"' })
    return res.end('ログインが必要です')
  }
  fails.delete(ip)
  if (req.method !== 'GET') return send(res, 405, { error: 'method_not_allowed' })

  const url = new URL(req.url, 'http://x')
  const t0 = performance.now()
  try {
    if (url.pathname === '/' || url.pathname === '/index.html') return send(res, 200, PAGE, 'text/html; charset=utf-8')
    if (url.pathname === '/favicon.ico') return send(res, 204, '')
    if (url.pathname === '/api/overview') return send(res, 200, getOverview(db))
    if (url.pathname === '/api/jobs') {
      const q = Object.fromEntries(url.searchParams)
      const r = searchJobs(db, q)
      return send(res, 200, { ...r, ms: Math.round(performance.now() - t0) })
    }
    const m = url.pathname.match(/^\/api\/jobs\/(\d+)$/)
    if (m) {
      const j = getJob(db, m[1])
      return j ? send(res, 200, j) : send(res, 404, { error: 'not_found' })
    }
    return send(res, 404, { error: 'not_found' })
  } catch (e) {
    console.error(new Date().toISOString(), req.url, e.message)
    // DBファイルが差し替えられた（バックアップから復元など）場合に備えて開き直す
    if (/database|disk|malformed/i.test(e.message)) { try { db.close() } catch {}; db = openDb(cfg.dbPath, { readonly: true }) }
    return send(res, 500, { error: 'internal_error', message: e.message })
  }
})

server.listen(PORT, HOST, () => console.log(`求人データハブ 検索サーバー: http://${HOST}:${PORT}/  ${LOOPBACK ? '（サーバー内部専用）' : '（外部公開）'} 認証=${AUTH_REQUIRED ? 'あり' : 'なし'}`))
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { server.close(); try { db.close() } catch {}; process.exit(0) })
