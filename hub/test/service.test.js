// AI検索サービス（求職者・書類・紹介済み・キュー）のテスト。OpenAI は偽のサーバー
import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import fs from 'node:fs'
import { openDb } from '../lib/db.js'
import { SyncSession } from '../lib/engine.js'
import { openWorkspace } from '../lib/workspace.js'
import { createService, normalizeCriteria } from '../lib/ai/service.js'

function setupJobs() {
  const db = openDb(':memory:')
  const s = new SyncSession(db, { source: 'hitolink', runId: 1, cfg: { closeAfterMisses: 1, maxCloseRatio: 1 } })
  const jobs = [
    { sourceJobId: '1', title: '法人営業（IT商材）', company: 'A社', jobCategory: '営業', employment: '正社員', locations: ['東京都港区'], description: 'SaaSの提案営業', requirements: '法人営業経験3年以上', salaryMin: 5000000, salaryMax: 7000000 },
    { sourceJobId: '2', title: 'カスタマーサクセス', company: 'B社', jobCategory: 'カスタマーサクセス', employment: '正社員', locations: ['東京都渋谷区'], description: '既存顧客の活用支援', requirements: '社会人経験2年以上', salaryMin: 4500000 },
    { sourceJobId: '3', title: '営業企画', company: 'C社', jobCategory: '企画', employment: '正社員', locations: ['東京都'], description: '営業戦略の立案', requirements: '営業経験', salaryMin: 5500000 },
  ]
  s.ingest(jobs.map((m) => ({ mapped: m, raw: {} })))
  s.finalize({ complete: true, remoteTotal: jobs.length })
  return db
}

function fakeOpenAI() {
  const calls = []
  const server = http.createServer(async (req, res) => {
    let body = ''; for await (const c of req) body += c
    const j = JSON.parse(body); calls.push(j)
    const sys = j.messages[0].content, u = j.messages[1].content
    let out
    if (sys.includes('漏れなく正確に構造化')) out = { summary: '法人営業5年', jobTypeYears: { 法人営業: 5 }, licenses: [], careers: [] }
    else if (sys.includes('計画')) out = { understanding: '営業経験を活かしたい', priorities: [], dealbreakers: [], mustHave: [], angles: [{ type: '王道', label: '営業', why: '', keywords: ['営業', 'カスタマーサクセス'] }] }
    else if (sys.includes('ふるい分け')) { const n = (u.match(/^\[\d+\]/gm) || []).length; out = { s: Array.from({ length: n }, (_, i) => [i, 4, 1, 1]) } }
    else if (sys.includes('提案する文章')) { const n = (u.match(/===== 求人\[\d+\] =====/g) || []).length; out = { r: Array.from({ length: n }, (_, i) => ({ i, reason: '推薦文', concerns: [], checkPoints: [] })) } }
    else { const n = (u.match(/===== 求人\[\d+\] =====/g) || []).length; out = { r: Array.from({ length: n }, (_, i) => ({ i, score: 80, must: [{ req: '経験', status: 'met', evidence: '営業5年' }], angle: '王道' })) } }
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(out) }, finish_reason: 'stop' }], usage: { prompt_tokens: 100, completion_tokens: 20 } }))
  })
  return new Promise((r) => server.listen(0, '127.0.0.1', () => r({ server, calls, url: `http://127.0.0.1:${server.address().port}/v1` })))
}

const admin = { id: 1, name: '大森大地', role: 'admin' }
const staff = { id: 2, name: '担当A', role: 'staff' }
const req = (svc, method, path, body, user = admin) => {
  const [p, q = ''] = path.split('?')
  return svc.handle({ method, path: p, query: new URLSearchParams(q), body, user })
}
async function waitDone(svc, id) {
  for (let i = 0; i < 200; i++) {
    await svc.tick()
    const r = await req(svc, 'GET', `/searches/${id}`)
    if (['done', 'error', 'cancelled'].includes(r.body.status)) return r.body
    await new Promise((x) => setTimeout(x, 20))
  }
  throw new Error('timeout')
}

test('条件の整形（想定外の値は捨てる）', () => {
  const c = normalizeCriteria({ locations: ['東京都', 'ニューヨーク'], features: ['remote', 'evil'], sources: ['circus', 'x'], gender: '?', age: '200', topN: 0, jobKeys: ['circus:1', 'bad'] })
  assert.deepEqual(c.locations, ['東京都']); assert.deepEqual(c.features, ['remote']); assert.deepEqual(c.sources, ['circus'])
  assert.equal(c.gender, ''); assert.equal(c.age, 80); assert.equal(c.topN, 1); assert.deepEqual(c.jobKeys, ['circus:1'])
})

test('求職者の登録（名前＋自動採番）・書類（PDFは保存せず伏せ字の本文だけ）・紹介済みの除外・検索履歴', async () => {
  const f = await fakeOpenAI()
  const env = { OPENAI_BASE_URL: f.url, OPENAI_API_KEY: 'k', HUB_AI_MODEL_SMART: 'm-smart', HUB_AI_MODEL_FAST: 'm-fast', HUB_AI_FALLBACK_MODELS: 'm-smart', HUB_AI_FALLBACK_FAST_MODELS: 'm-fast' }
  const ws = openWorkspace(':memory:')
  const svc = createService({ env, jobsDb: setupJobs(), ws, log: () => {} })
  try {
    const a = await req(svc, 'POST', '/candidates', { name: '山田 太郎' })
    const b = await req(svc, 'POST', '/candidates', { name: '山田 太郎' })
    assert.ok(a.body.ok && b.body.id === a.body.id + 1)                  // 同姓同名は番号で区別
    assert.equal((await req(svc, 'POST', '/candidates', { name: ' ' })).status, 400)
    const id = a.body.id

    // 書類: 本文から氏名が消える。PDF（base64）は保存されない
    const pdf = fs.readFileSync('/tmp/cv.pdf').toString('base64')
    const d = await req(svc, 'POST', `/candidates/${id}/documents`, { kind: 'cv', filename: 'cv.pdf', pdfBase64: pdf, names: ['山田'] })
    assert.equal(d.status, 200, JSON.stringify(d.body))
    const row = ws.prepare('SELECT * FROM candidate_documents WHERE id=?').get(d.body.id)
    assert.ok(!('pdf_base64' in row) && row.masked_text.length > 30)
    assert.equal((await req(svc, 'POST', `/candidates/${id}/documents`, { pdfBase64: Buffer.from('hello').toString('base64') })).status, 400)

    // 紹介済み → 検索で自動的に除外
    assert.ok((await req(svc, 'POST', `/candidates/${id}/referrals`, { job_key: 'hitolink:1', title: '法人営業（IT商材）' })).body.ok)
    const s = await req(svc, 'POST', '/searches', { candidateId: id, criteria: { freeText: '営業経験を活かしたい', topN: 10 } }, staff)
    assert.ok(s.body.ok)
    const done = await waitDone(svc, s.body.id)
    assert.equal(done.status, 'done', done.error)
    assert.equal(done.user_name, '担当A')                                  // 担当者が記録される
    assert.ok(done.summary.hasProfile)                                       // 書類から経歴を作って使った
    assert.ok(done.recommended.length >= 1, JSON.stringify(done.summary) + JSON.stringify(done.log?.slice(-6)))
    assert.ok(!done.recommended.some((r) => r.key === 'hitolink:1'))        // 紹介済みは出ない
    assert.ok(done.recommended.every((r) => r.reason === '推薦文' && r.must.length))
    assert.ok(done.summary.totalUsd != null || done.summary.usage)

    // 経歴は書類が変わらなければ作り直さない（2回目の検索で読み取りを呼ばない）
    const before = f.calls.filter((c) => c.messages[0].content.includes('漏れなく正確に構造化')).length
    const s2 = await req(svc, 'POST', '/searches', { candidateId: id, criteria: { freeText: '営業', topN: 5 } })
    await waitDone(svc, s2.body.id)
    assert.equal(f.calls.filter((c) => c.messages[0].content.includes('漏れなく正確に構造化')).length, before)

    // 求職者の画面: 書類・紹介済み・検索履歴・前回の条件
    const c = (await req(svc, 'GET', `/candidates/${id}`)).body
    assert.equal(c.documents.length, 1); assert.equal(c.referrals.length, 1); assert.equal(c.searches.length, 2)
    assert.equal(c.conditions.freeText, '営業'); assert.ok(c.profile_fresh)
    // 一覧・番号で検索
    assert.equal((await req(svc, 'GET', `/candidates?q=No.${id}`)).body.items[0].id, id)
    // 削除は管理者だけ。削除すると関連データも消える
    assert.equal((await req(svc, 'DELETE', `/candidates/${id}`, {}, staff)).status, 403)
    assert.ok((await req(svc, 'DELETE', `/candidates/${id}`)).body.ok)
    assert.equal(ws.prepare('SELECT COUNT(*) AS n FROM ai_searches WHERE candidate_id=?').get(id).n, 0)
    assert.equal(ws.prepare('SELECT COUNT(*) AS n FROM candidate_documents WHERE candidate_id=?').get(id).n, 0)
  } finally { svc.close(); f.server.close() }
})

test('順番待ち・開始前の中止・再起動で中断された検索の回収', async () => {
  const ws = openWorkspace(':memory:')
  ws.prepare(`INSERT INTO ai_searches (id, criteria_json, status) VALUES ('old', '{}', 'running')`).run()
  const svc = createService({ env: { OPENAI_API_KEY: 'k', OPENAI_BASE_URL: 'http://127.0.0.1:9/v1' }, jobsDb: setupJobs(), ws, log: () => {} })
  try {
    assert.equal(ws.prepare(`SELECT status FROM ai_searches WHERE id='old'`).get().status, 'error')
    const ids = ['q1', 'q2']
    for (const id of ids) ws.prepare(`INSERT INTO ai_searches (id, criteria_json) VALUES (?, '{}')`).run(id)
    const g = await req(svc, 'GET', '/searches/q2')
    assert.equal(g.body.queuePosition, 2)
    assert.ok((await req(svc, 'POST', '/searches/q2/cancel')).body.ok)
    assert.equal(ws.prepare(`SELECT status FROM ai_searches WHERE id='q2'`).get().status, 'cancelled')
    assert.equal((await req(svc, 'POST', '/searches', { criteria: {} })).status, 400) // 要望も書類もない
  } finally { svc.close() }
})
