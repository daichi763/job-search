// 同期エンジンの動作テスト（媒体には接続しない。メモリ上のDBで確認）
import test from 'node:test'
import assert from 'node:assert/strict'
import { openDb } from '../lib/db.js'
import { SyncSession, purge } from '../lib/engine.js'
import { searchJobs } from '../lib/search.js'
import { toBigrams, toMatchQuery } from '../lib/text.js'
import { extractPrefectures } from '../lib/normalize.js'

const cfg = { closeAfterMisses: 2, maxCloseRatio: 0.05, deleteAfterHours: 24, changeLogDays: 90 }
const mk = (id, over = {}) => ({
  mapped: {
    sourceJobId: String(id), title: `法人営業スタッフ${id}`, company: `株式会社テスト${id}`,
    locations: ['東京都千代田区'], salaryMin: 4000000, salaryMax: 6000000, description: '未経験歓迎の経理事務',
    lastUpdatedAt: '2026-10-01T00:00:00Z', ...over,
  },
  raw: { id, ...over },
})
function run(db, items, { complete = true, total = items.length, authoritative = false, c = cfg } = {}) {
  const runId = Number(db.prepare(`INSERT INTO sync_runs(source,status,started_at) VALUES('t','running','x')`).run().lastInsertRowid)
  const s = new SyncSession(db, { source: 't', runId, cfg: c, authoritative })
  s.ingest(items)
  const fin = s.finalize({ complete, remoteTotal: total, reason: 'test' })
  return { ...s.stats, ...fin }
}
const status = (db, id) => db.prepare(`SELECT status FROM jobs WHERE source_job_id=?`).get(String(id))?.status

test('追加 → 変化なし → 更新 → 軽更新', () => {
  const db = openDb(':memory:')
  const base = Array.from({ length: 100 }, (_, i) => mk(i))
  let r = run(db, base)
  assert.equal(r.added, 100)
  r = run(db, base)
  assert.equal(r.unchanged, 100)
  const changed = base.map((x, i) => (i === 5 ? mk(5, { salaryMax: 7000000 }) : i === 6 ? mk(6, { lastUpdatedAt: '2026-10-02T00:00:00Z' }) : x))
  r = run(db, changed)
  assert.equal(r.updated, 1)
  assert.equal(r.refreshed, 1)
  assert.equal(r.unchanged, 98)
  const ch = db.prepare(`SELECT changed_fields FROM job_changes WHERE change_type='updated'`).get()
  assert.deepEqual(JSON.parse(ch.changed_fields), ['salary_max'])
})

test('掲載終了は2回連続で一覧に無い時だけ / 読み切れない回は判定しない / 再掲載', () => {
  const db = openDb(':memory:')
  const base = Array.from({ length: 100 }, (_, i) => mk(i))
  run(db, base)
  const without = base.filter((_, i) => i !== 7)
  let r = run(db, without)
  assert.equal(r.missing, 1); assert.equal(r.closed, 0); assert.equal(status(db, 7), 'open')
  r = run(db, without, { complete: false })
  assert.equal(r.closed, 0); assert.match(r.note, /読み切れなかった/)
  r = run(db, without)
  assert.equal(r.closed, 1); assert.equal(status(db, 7), 'closed')
  r = run(db, base)
  assert.equal(r.reopened, 1); assert.equal(status(db, 7), 'open')
})

test('一度に5%を超えて消えたら判定を保留する', () => {
  const db = openDb(':memory:')
  const base = Array.from({ length: 100 }, (_, i) => mk(i))
  run(db, base, { authoritative: true })
  const r = run(db, base.slice(0, 90), { authoritative: true, total: 90 })
  assert.equal(r.closed, 0); assert.match(r.note, /保留/)
})

test('kintone（確実に全件読める媒体）は1回で掲載終了 → 24時間後に削除', () => {
  const db = openDb(':memory:')
  const base = Array.from({ length: 100 }, (_, i) => mk(i))
  run(db, base, { authoritative: true })
  const r = run(db, base.slice(1), { authoritative: true })
  assert.equal(r.closed, 1)
  assert.deepEqual(purge(db, cfg), {}) // まだ24時間経っていない
  db.prepare(`UPDATE jobs SET closed_at='2000-01-01T00:00:00Z' WHERE status='closed'`).run()
  assert.deepEqual(purge(db, cfg), { t: 1 })
  assert.equal(db.prepare(`SELECT COUNT(*) n FROM jobs`).get().n, 99)
  assert.equal(db.prepare(`SELECT COUNT(*) n FROM job_raw`).get().n, 99)
  assert.equal(db.prepare(`SELECT COUNT(*) n FROM job_texts`).get().n, 99)
})

test('ページずれによる重複は1件として扱う', () => {
  const db = openDb(':memory:')
  const r = run(db, [mk(1), mk(2), mk(2), mk(3)])
  assert.equal(r.added, 3); assert.equal(r.duplicates, 1)
})

test('2文字語・複数語・都道府県での検索', () => {
  const db = openDb(':memory:')
  run(db, [mk(1), mk(2, { title: 'Webエンジニア', description: '自社開発', locations: ['大阪'] }), mk(3, { title: '営業／事務', description: '' })])
  assert.equal(searchJobs(db, { keyword: '営業' }).total, 2)
  assert.equal(searchJobs(db, { keyword: '経理' }).total, 1)
  assert.equal(searchJobs(db, { keyword: 'ｴﾝｼﾞﾆｱ' }).total, 1)     // 半角カナでも当たる
  assert.equal(searchJobs(db, { keyword: 'WEB' }).total, 1)         // 大文字小文字の違いを吸収
  assert.equal(searchJobs(db, { keyword: '法人営業 未経験' }).total, 1)
  assert.equal(searchJobs(db, { keyword: '業事' }).total, 0)         // 「営業／事務」の区切りをまたいで誤検出しない
  assert.equal(searchJobs(db, { prefecture: '大阪府' }).total, 1)
  assert.equal(searchJobs(db, { prefecture: '東京都', salaryMin: 5000000 }).total, 2)
})

test('都道府県の抽出', () => {
  assert.deepEqual(extractPrefectures(['東京都港区']), ['東京都'])
  assert.deepEqual(extractPrefectures(['京都市']), ['京都府'])
  assert.deepEqual(extractPrefectures(['大阪', '兵庫県神戸市']).sort(), ['兵庫県', '大阪府'].sort())
  assert.deepEqual(extractPrefectures(['全国（フルリモート）']), ['全国'])
  assert.equal(toBigrams('法人営業'), '法人 人営 営業')
  assert.equal(toMatchQuery('営業').match, '"営業"')
})

test('初回の取り込みで新規分を「一覧に無い」と数えない', () => {
  const db = openDb(':memory:')
  const r = run(db, Array.from({ length: 50 }, (_, i) => mk(i)))
  assert.equal(r.added, 50); assert.equal(r.missing, 0); assert.equal(r.note, null)
})
