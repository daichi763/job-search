// AI検索エンジンのテスト（OpenAI は使わず、偽のサーバーで応答を返す）
import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { openDb } from '../lib/db.js'
import { SyncSession } from '../lib/engine.js'
import { runAiSearch, finalizeScore, engineConfig, eduAllowed, genderAllowed, criteriaToQuery, buildPool } from '../lib/ai/engine.js'
import { maskPII, profileToText } from '../lib/ai/profile.js'
import { chatJson, Usage, _test } from '../lib/ai/llm.js'

function setupDb() {
  const db = openDb(':memory:')
  const s = new SyncSession(db, { source: 'hitolink', runId: 1, cfg: { closeAfterMisses: 1, maxCloseRatio: 1 } })
  const jobs = [
    { sourceJobId: '1', title: '法人営業（IT商材）', jobCategory: '営業', employment: '正社員', locations: ['東京都港区'], description: 'SaaSの提案営業', requirements: '法人営業経験3年以上必須', salaryMin: 5000000, salaryMax: 7000000 },
    { sourceJobId: '2', title: 'カスタマーサクセス', jobCategory: 'カスタマーサクセス', employment: '正社員', locations: ['東京都渋谷区'], description: '既存顧客の活用支援。営業経験を活かせます', requirements: '社会人経験2年以上', salaryMin: 4500000 },
    { sourceJobId: '3', title: '営業マネージャー', jobCategory: '営業', employment: '正社員', locations: ['大阪府'], description: '営業組織のマネジメント', requirements: 'マネジメント経験5年以上必須', salaryMin: 8000000 },
    { sourceJobId: '4', title: '経理スタッフ', jobCategory: '経理', employment: '正社員', locations: ['東京都'], description: '月次決算', requirements: '日商簿記2級', requiredEducation: '大卒以上' },
    { sourceJobId: '5', title: '営業事務', jobCategory: '事務', employment: '派遣', locations: ['東京都'], description: '受発注', requirements: '不問' },
  ]
  s.ingest(jobs.map((m) => ({ mapped: m, raw: {} })))
  s.finalize({ complete: true, remoteTotal: jobs.length })
  return db
}

// 偽の OpenAI。リクエストの内容に応じて決まった応答を返す
function fakeOpenAI(handler) {
  const calls = []
  const server = http.createServer(async (req, res) => {
    let body = ''
    for await (const c of req) body += c
    const j = JSON.parse(body)
    calls.push(j)
    const out = handler(j, calls)
    if (out.status) { res.writeHead(out.status); return res.end(out.body || '') }
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(out) }, finish_reason: 'stop' }], usage: { prompt_tokens: 100, completion_tokens: 20 } }))
  })
  return new Promise((r) => server.listen(0, '127.0.0.1', () => r({ server, calls, url: `http://127.0.0.1:${server.address().port}/v1` })))
}

test('必須要件を満たさない求人は点数に上限がかかる（85点問題）', () => {
  const cfg = engineConfig({})
  const unmet = finalizeScore({ score: 92, must: [{ status: 'met' }, { status: 'unmet' }] }, { hasProfile: true, cfg })
  assert.equal(unmet.score, cfg.capUnmet); assert.equal(unmet.eligibility, 'unmet'); assert.equal(unmet.rawScore, 92)
  const unknown = finalizeScore({ score: 90, must: [{ status: 'unknown' }] }, { hasProfile: true, cfg })
  assert.equal(unknown.score, cfg.capUnknown)
  // 書類が無いときは「不明」で減点しない（判断材料が無いだけなので）
  assert.equal(finalizeScore({ score: 90, must: [{ status: 'unknown' }] }, { hasProfile: false, cfg }).score, 90)
  assert.equal(finalizeScore({ score: 88, must: [{ status: 'met' }] }, { hasProfile: true, cfg }).score, 88)
})

test('学歴・性別は確定条件として機械的に判定する', () => {
  assert.equal(eduAllowed('大卒以上', '高卒'), false)
  assert.equal(eduAllowed('大卒以上', '大学院卒'), true)
  assert.equal(eduAllowed('学歴不問', '高卒'), true)
  assert.equal(eduAllowed('高卒以上', '専門卒'), true)
  assert.equal(eduAllowed(null, '高卒'), true)
  assert.equal(genderAllowed('男性', '女性'), false)
  assert.equal(genderAllowed('不問', '女性'), true)
})

test('画面の条件 → 求人DBの絞り込み（勤務地は全国対応も含める・紹介済みを除外）', () => {
  const q = criteriaToQuery({ locations: ['東京都'], salaryMin: 450, employment: ['正社員'], excludeKeys: ['hitolink:1'] })
  assert.equal(q.prefecture, '東京都,全国'); assert.equal(q.salaryMin, 4500000); assert.equal(q.excludeKeys, 'hitolink:1')
  const db = setupDb()
  const p = buildPool(db, { locations: ['東京都'], employment: ['正社員'], education: '高卒', excludeKeys: ['hitolink:2'] })
  // 東京×正社員 = 1,2,4 → 2は紹介済み、4は大卒以上なので除外 → 1 だけ
  assert.deepEqual(p.ids.length, 1); assert.equal(p.excluded.education, 1)
})

test('個人情報を伏せる（氏名・電話・メール・住所）', () => {
  const t = maskPII('氏名：山田 太郎\n山田太郎は営業\nTEL 090-1234-5678\nmail: a.b@example.com\n住所：東京都港区芝公園4-2-8\n2015年4月〜2020年3月 株式会社A', { names: ['山田 太郎'] })
  assert.ok(!t.includes('山田') && !t.includes('090-1234') && !t.includes('example.com') && !t.includes('芝公園'))
  assert.ok(t.includes('2015年4月〜2020年3月'))
})

test('経歴の文章化（資格なしも明示する）', () => {
  const s = profileToText({ summary: '営業5年', jobTypeYears: { 法人営業: 5 }, licenses: [], management: { has: false } })
  assert.match(s, /法人営業 約5年/); assert.match(s, /資格・免許】記載なし/); assert.match(s, /マネジメント】経験の記載なし/)
})

test('使えないモデルは次の候補に自動で切り替える', async () => {
  const f = await fakeOpenAI((j) => (j.model === 'gpt-x' ? { status: 404, body: '{"error":{"message":"The model gpt-x does not exist"}}' } : { ok: 1 }))
  const u = new Usage()
  const r = await chatJson({ OPENAI_BASE_URL: f.url, OPENAI_API_KEY: 'k' }, { models: ['gpt-x', 'gpt-5'], system: 's', user: 'u', usage: u })
  assert.equal(r.model, 'gpt-5'); assert.ok(_test.unavailable.has('gpt-x')); assert.equal(u.calls, 1)
  f.server.close()
})

test('AI検索の全体: 理解→絞込→一次審査→精査、満たさない求人は提案から外れ参考に回る', async () => {
  const db = setupDb()
  const f = await fakeOpenAI((j) => {
    const sys = j.messages[0].content
    if (sys.includes('計画')) return { understanding: '営業経験を活かしたい', priorities: ['年収'], dealbreakers: [], mustHave: [],
      angles: [{ type: '王道', label: '法人営業', why: '経験', keywords: ['法人営業', '提案営業'] }, { type: '意外', label: 'CS', why: '隣接', keywords: ['カスタマーサクセス'] }] }
    if (sys.includes('ふるい分け')) {
      const n = (j.messages[1].content.match(/^\[\d+\]/gm) || []).length
      return { s: Array.from({ length: n }, (_, i) => [i, 4, 1, 1]) }
    }
    const u = j.messages[1].content
    // 推薦文（提案に残った求人だけ）
    if (sys.includes('提案する文章')) {
      const n = (u.match(/===== 求人\[\d+\] =====/g) || []).length
      return { r: Array.from({ length: n }, (_, i) => ({ i, reason: `推薦文${i}`, concerns: [], checkPoints: ['確認'] })) }
    }
    // 精査: 求人票の内容で判定を変える
    const blocks = u.split(/===== 求人\[(\d+)\] =====/).slice(1)
    const r = []
    for (let k = 0; k < blocks.length; k += 2) {
      const i = Number(blocks[k]), text = blocks[k + 1]
      if (text.includes('マネジメント経験5年以上')) r.push({ i, score: 90, must: [{ req: 'マネジメント5年', status: 'unmet', evidence: 'なし' }], reason: '高年収', angle: '発展' })
      else r.push({ i, score: text.includes('法人営業経験3年') ? 88 : 75, must: [{ req: '経験', status: 'met', evidence: '営業5年' }], reason: '合う', angle: '王道' })
    }
    return { r }
  })
  const env = { OPENAI_BASE_URL: f.url, OPENAI_API_KEY: 'k', HUB_AI_MODEL_SMART: 'm-smart', HUB_AI_MODEL_FAST: 'm-fast', HUB_AI_FALLBACK_MODELS: 'm-smart', HUB_AI_FALLBACK_FAST_MODELS: 'm-fast' }
  const stages = []
  const res = await runAiSearch(env, db, { freeText: '営業経験を活かして年収アップ', employment: ['正社員'], topN: 10 }, {
    profile: { summary: '法人営業5年', jobTypeYears: { 法人営業: 5 } }, onProgress: (p) => stages.push(p.stage),
  })
  assert.equal(res.pool.size, 4) // 派遣を除く
  assert.deepEqual([...new Set(stages)], ['plan', 'pool', 'screen', 'deep', 'write', 'done'])
  const titles = res.recommended.map((r) => r.job.title)
  assert.equal(titles[0], '法人営業（IT商材）')
  assert.ok(!titles.includes('営業マネージャー'))                       // 必須要件を満たさない
  assert.equal(res.reference[0].job.title, '営業マネージャー')          // 参考に回る
  assert.equal(res.reference[0].score, engineConfig({}).capUnmet)
  // 一次審査は安いモデル、精査は優秀モデル
  const models = f.calls.map((c) => c.model)
  assert.ok(models.includes('m-fast') && models.includes('m-smart'))
  assert.ok(res.summary.usage.tokens > 0)
  assert.ok(res.recommended.every((r) => r.reason.startsWith('推薦文')))           // 推薦文は提案に残った求人だけ
  assert.ok(!f.calls.some((c) => c.messages[0].content.includes('提案する文章') && c.messages[1].content.includes('マネジメント経験5年以上')))
  assert.ok(res.summary.usage.byStage['一次審査'] && res.summary.usage.byStage['精査（判定）'] && res.summary.usage.byStage['推薦文'])
  f.server.close()
})

test('一次審査の点数換算・精査対象の選び方・同じ求人のまとめ', async () => {
  const { screenPoint, pickForDeep, dupKey } = await import('../lib/ai/engine.js')
  assert.equal(screenPoint(5, 1, 1), 95)
  assert.equal(screenPoint(4, 0, 1), 65)
  assert.equal(screenPoint(5, 1, 0), 30) // 必須要件を明らかに満たさない
  // 切り口ごとに枠を確保する（点数の高い切り口0だけで埋まらない）
  const ids = [1, 2, 3, 4, 5, 6]
  const screen = new Map([[1, 95], [2, 95], [3, 95], [4, 95], [5, 70], [6, 70]])
  const score = new Map(ids.map((id) => [id, { total: 1, byAngle: id <= 4 ? [1, 0] : [0, 1] }]))
  const picked = pickForDeep(ids, screen, score, [{}, {}], 4, 50)
  assert.ok(picked.includes(5))                 // 点数の低い切り口1からも必ず入る
  assert.equal(pickForDeep(ids, screen, score, [{}, {}], 6, 50).length, 6)
  assert.equal(dupKey({ company: '株式会社ABC', title: '【急募】法人営業' }), dupKey({ company: 'ABC', title: '法人営業' }))
})

import { screenPoint, pickForDeep, dupKey } from '../lib/ai/engine.js'

test('一次審査の点数換算（必須要件を満たさない求人は低く）', () => {
  assert.equal(screenPoint(5, 1, 1), 95)
  assert.equal(screenPoint(5, 0, 1), 80)   // 要望の中心から外れると下がる
  assert.equal(screenPoint(5, 1, 0), 30)   // 必須要件を明らかに満たさない
  assert.ok(screenPoint(3, 0, 2) < screenPoint(4, 1, 2))
})

test('精査の対象は切り口ごとに枠を確保する（同じ種類の求人で埋まらない）', () => {
  const ids = Array.from({ length: 30 }, (_, i) => i + 1)
  const screen = new Map(ids.map((id) => [id, id <= 20 ? 95 : 70]))
  // 1〜20 は切り口0、21〜30 は切り口1
  const score = new Map(ids.map((id) => [id, { total: 1, byAngle: id <= 20 ? [1, 0] : [0, 1] }]))
  const picked = pickForDeep(ids, screen, score, [{}, {}], 10, 50)
  assert.equal(picked.length, 10)
  assert.ok(picked.some((id) => id > 20), '切り口1の求人も入る')
})

test('同じ求人（媒体違い）の判定', () => {
  assert.equal(dupKey({ company: '株式会社サンプル', title: '【急募】法人営業' }), dupKey({ company: 'サンプル(株)', title: '法人営業' }))
  assert.notEqual(dupKey({ company: 'A社', title: '経理' }), dupKey({ company: 'A社', title: '法人営業' }))
  assert.equal(dupKey({ company: '', title: 'x' }), null)
})
