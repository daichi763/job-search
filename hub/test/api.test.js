// 外部向け検索API v1 のテスト（メモリ上のDB）
import test from 'node:test'
import assert from 'node:assert/strict'
import { openDb } from '../lib/db.js'
import { SyncSession } from '../lib/engine.js'
import { handleApiV1 } from '../lib/api.js'

const cfg = { closeAfterMisses: 1, maxCloseRatio: 1 }
function setup() {
  const db = openDb(':memory:')
  const s = new SyncSession(db, { source: 'circus', runId: 1, cfg })
  s.ingest([
    { mapped: { sourceJobId: 'A1', title: '法人営業', company: '株式会社A', locations: ['東京都港区'], salaryMin: 4000000, salaryMax: 6000000, requiredAgeMin: 20, requiredAgeMax: 35, reward: { type: 'rate', rate: 30 }, description: '未経験歓迎' }, raw: { id: 'A1', secret: 'x' } },
    { mapped: { sourceJobId: 'A2', title: '経理事務', company: '株式会社B', locations: ['大阪府'], salaryMin: 3000000, salaryMax: 4000000, reward: { type: 'fixed', amount: 500000 } }, raw: { id: 'A2' } },
    { mapped: { sourceJobId: 'A3', title: 'インフラエンジニア', company: '株式会社C', locations: ['東京都'], salaryMin: 6000000, salaryMax: 9000000 }, raw: { id: 'A3' } },
  ])
  s.finalize({ complete: true, remoteTotal: 3 })
  return db
}
const call = (db, path, qs = '') => handleApiV1(db, path, new URLSearchParams(qs))

test('検索: 条件・年収は万円・識別子は「媒体:ID」', () => {
  const db = setup()
  let r = call(db, '/api/v1/jobs', 'q=営業')
  assert.equal(r.status, 200); assert.equal(r.body.meta.total, 1)
  const j = r.body.data[0]
  assert.equal(j.id, 'circus:A1'); assert.equal(j.salary_min, 400); assert.equal(j.salary_max, 600)
  assert.equal(j.reward.rate, 30); assert.equal(j.description, undefined) // 一覧には長文を含めない
  assert.equal(call(db, '/api/v1/jobs', 'prefecture=東京都&salary_min=500').body.meta.total, 2)
  assert.equal(call(db, '/api/v1/jobs', 'age=40').body.meta.total, 2) // A1(〜35歳)は除外、年齢不明は含める
  assert.equal(call(db, '/api/v1/jobs', 'reward_type=fixed').body.data[0].reward.amount, 50)
  assert.equal(call(db, '/api/v1/jobs', 'sort=salary_desc').body.data[0].id, 'circus:A3')
  assert.ok(call(db, '/api/v1/jobs', 'fields=full').body.data[0].description !== undefined)
})

test('ページ送り', () => {
  const db = setup()
  const r = call(db, '/api/v1/jobs', 'per_page=2&page=2')
  assert.equal(r.body.data.length, 1); assert.equal(r.body.meta.total_pages, 2)
})

test('詳細: 元データは include=raw のときだけ / 無い求人は404', () => {
  const db = setup()
  let r = call(db, '/api/v1/jobs/circus:A1')
  assert.equal(r.status, 200); assert.equal(r.body.data.description, '未経験歓迎'); assert.deepEqual(r.body.data.prefectures, ['東京都'])
  assert.equal(r.body.data.raw, undefined)
  r = call(db, '/api/v1/jobs/circus%3AA1', 'include=raw')
  assert.equal(r.body.data.raw.secret, 'x')
  assert.equal(call(db, '/api/v1/jobs/circus:ZZZ').status, 404)
  assert.equal(call(db, '/api/v1/jobs/unknown:A1').status, 404)
})

test('入力の誤りは 400 と理由を返す', () => {
  const db = setup()
  for (const qs of ['per_page=1000', 'page=0', 'salary_min=abc', 'sort=foo', 'source=xxx', 'changed_since=昨日', 'page=999&per_page=100']) {
    const r = call(db, '/api/v1/jobs', qs)
    assert.equal(r.status, 400, qs); assert.equal(r.body.error.code, 'bad_request'); assert.ok(r.body.error.message)
  }
  assert.equal(call(db, '/api/v1/nothing').status, 404)
})

test('媒体一覧・都道府県・変更履歴', () => {
  const db = setup()
  const s = call(db, '/api/v1/sources').body.data
  assert.equal(s.length, 4); assert.equal(s.find((x) => x.source === 'circus').open, 3)
  assert.equal(call(db, '/api/v1/prefectures').body.data[0].prefecture, '東京都')
  let c = call(db, '/api/v1/changes', 'since=2000-01-01T00:00:00Z&limit=2')
  assert.equal(c.body.data.length, 2); assert.equal(c.body.meta.has_more, true)
  c = call(db, '/api/v1/changes', `since=2000-01-01T00:00:00Z&after_id=${c.body.meta.next_after_id}`)
  assert.equal(c.body.data.length, 1); assert.equal(c.body.data[0].type, 'added')
})
