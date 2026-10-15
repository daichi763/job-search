// 働き方タグ・新しい検索条件・CSV のテスト
import test from 'node:test'
import assert from 'node:assert/strict'
import { openDb } from '../lib/db.js'
import { SyncSession } from '../lib/engine.js'
import { detectFeatures } from '../lib/features.js'
import { handleApiV1 } from '../lib/api.js'
import { backfillFeatures } from '../lib/backfill.js'

test('働き方タグの判定（否定表現は除外）', () => {
  const f = (text, raw = null, src = 'jobins') => detectFeatures(src, { description: text }, raw)
  assert.deepEqual(f('フルリモート可・フレックスタイム制'), ['flex', 'remote'])
  assert.deepEqual(f('リモートワーク不可。出社必須'), [])
  assert.deepEqual(f('副業OK！'), ['side_job'])
  assert.deepEqual(f('副業は禁止です'), [])
  assert.deepEqual(f('年間休日125日、土日祝休み'), ['holidays_120', 'weekend_off'])
  assert.deepEqual(f('年間休日105日'), [])
  assert.deepEqual(f('転勤なし'), ['no_transfer'])
  assert.deepEqual(f('職種未経験歓迎'), ['inexperienced_ok'])
  assert.deepEqual(f('', { isRemoteOk: true, isSideJobOk: true }, 'hitolink'), ['remote', 'side_job'])
  assert.deepEqual(f('', { workEnvironments: [2, 5] }, 'circus'), ['flex', 'remote'])
  assert.deepEqual(f('', { characteristics: [{ name: 'リモート勤務可' }] }), ['remote']) // 元データの値も見る
})

function setup() {
  const db = openDb(':memory:')
  const s = new SyncSession(db, { source: 'jobins', runId: 1, cfg: { closeAfterMisses: 1, maxCloseRatio: 1 } })
  s.ingest([
    { mapped: { sourceJobId: 'a', title: '法人営業', jobCategory: '営業', employment: '正社員', description: 'フルリモート・副業OK', salaryMin: 5000000 }, raw: {} },
    { mapped: { sourceJobId: 'b', title: '経理', jobCategory: '経理・財務', employment: '契約社員', description: 'フレックス', salaryMin: 4000000 }, raw: {} },
    { mapped: { sourceJobId: 'c', title: '="危険"な求人', jobCategory: 'エンジニア', employment: '正社員', description: '出社', salaryMin: 6000000 }, raw: {} },
  ])
  s.finalize({ complete: true, remoteTotal: 3 })
  return db
}
const call = (db, path, qs = '') => handleApiV1(db, path, new URLSearchParams(qs))

test('働き方・職種（複数）・雇用形態（複数）・除外で絞り込める', () => {
  const db = setup()
  assert.equal(call(db, '/api/v1/jobs', 'features=remote').body.meta.total, 1)
  assert.equal(call(db, '/api/v1/jobs', 'features=remote,side_job').body.meta.total, 1)
  assert.equal(call(db, '/api/v1/jobs', 'features=remote,flex').body.meta.total, 0) // すべて満たす
  assert.equal(call(db, '/api/v1/jobs', 'category=営業,経理').body.meta.total, 2)     // いずれか
  assert.equal(call(db, '/api/v1/jobs', 'employment=正社員,契約社員').body.meta.total, 3)
  assert.equal(call(db, '/api/v1/jobs', 'exclude=jobins:a,jobins:b').body.meta.total, 1)
  assert.deepEqual(call(db, '/api/v1/jobs', 'features=remote').body.data[0].features, ['remote', 'side_job'])
  assert.equal(call(db, '/api/v1/jobs', 'features=foo').status, 400)
})

test('絞り込みの選択肢', () => {
  const f = call(setup(), '/api/v1/facets').body.data
  assert.ok(f.categories.find((c) => c.value === '営業'))
  assert.equal(f.features.find((x) => x.value === 'remote').count, 1)
  assert.equal(f.employments[0].value, '正社員')
})

test('CSVダウンロード（Excel向け・数式の無害化・ID指定）', () => {
  const db = setup()
  const r = call(db, '/api/v1/jobs.csv', 'sort=salary_desc')
  assert.ok(r.csv.startsWith('\uFEFFID,媒体,求人タイトル'))
  const lines = r.csv.trim().split('\r\n')
  assert.equal(lines.length, 4)
  assert.ok(lines.some((l) => l.startsWith(`jobins:c,ジョビンズ,"'=""危険""な求人"`)), '数式になる文字の先頭に \' を付ける')
  assert.match(r.filename, /^jobs_\d{12}\.csv$/)
  const r2 = call(db, '/api/v1/jobs.csv', 'ids=jobins:b')
  assert.equal(r2.csv.trim().split('\r\n').length, 2)
})

test('既存の求人へのタグ付け直し', () => {
  const db = setup()
  db.exec('DELETE FROM job_features')
  const r = backfillFeatures(db)
  assert.equal(r.total, 3); assert.equal(r.counts.remote, 1); assert.equal(r.counts.flex, 1)
})
