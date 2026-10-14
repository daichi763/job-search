// 媒体ドライバの読み方テスト（偽の媒体で。実際の媒体には接続しない）
import test from 'node:test'
import assert from 'node:assert/strict'
import { openDb } from '../lib/db.js'
import { SyncSession } from '../lib/engine.js'
import { hitolink } from '../lib/drivers.js'

const cfg = { requestTimeoutMs: 5000, closeAfterMisses: 2, maxCloseRatio: 0.05, completeRatio: 0.98, pageRetry: 3, maxConsecutiveFail: 5, pageDelayMs: 0, recoverWaitMs: 0, recoverChunk: 25, maxUnreadable: 0, pageSize: { hitolink: 100 } }
const fakeBrowser = { newContext: async () => ({ newPage: async () => ({}), close: async () => {} }) }
function fakeHitolink(total, { failPage = null, failTimes = 0, badItem = null } = {}) {
  let fails = 0, logins = 0
  return {
    get logins() { return logins },
    hitolink: {
      login: async () => { logins++ }, getAuthToken: async () => 'tok', buildQJson: () => ({}),
      mapApiJob: (r) => ({ sourceJobId: r.matterId, title: 't' + r.matterId }),
      apiSearch: async (_p, _t, { limit, pageNo }) => {
        if (limit === 100 && pageNo === failPage && fails < failTimes) { fails++; throw new Error('一時エラー') }
        const start = (pageNo - 1) * limit
        if (badItem != null && badItem >= start && badItem < start + limit) throw new Error('circus status=500')
        const n = Math.max(0, Math.min(limit, total - start))
        return { total, jobs: Array.from({ length: n }, (_, i) => ({ matterId: String(start + i) })) }
      },
    },
  }
}
async function runDriver(fake) {
  const db = openDb(':memory:')
  const session = new SyncSession(db, { source: 'hitolink', runId: 1, cfg })
  const out = await hitolink.run({ cfg, env: {}, browser: fakeBrowser, log: () => {}, shouldStop: () => false, session, adapters: fake, onPage: (x) => session.ingest(x) })
  return { out, stats: session.stats }
}

test('全ページを読み切る（端数ページ含む）', async () => {
  const { out, stats } = await runDriver(fakeHitolink(1050))
  assert.equal(stats.fetched, 1050); assert.equal(out.complete, true); assert.equal(out.pagesOk, 11)
})
test('一時エラーは再ログインして再試行し、完走する', async () => {
  const f = fakeHitolink(500, { failPage: 3, failTimes: 1 })
  const { out, stats } = await runDriver(f)
  assert.equal(stats.fetched, 500); assert.equal(out.complete, true); assert.equal(f.logins, 2)
})
test('取れなかったページは最後に取り直す（小分けで成功）→ 読み切れた扱い', async () => {
  const { out, stats } = await runDriver(fakeHitolink(500, { failPage: 3, failTimes: 99 }))
  assert.equal(stats.fetched, 500); assert.equal(out.complete, true); assert.equal(out.pagesRecovered, 1); assert.equal(out.pagesFailed, 0)
})
test('壊れた1件だけ取れない場合、残りは取れる。取れない分があれば「読み切れていない」扱い', async () => {
  const { out, stats } = await runDriver(fakeHitolink(500, { badItem: 250 }))
  assert.equal(stats.fetched, 499); assert.equal(out.unreadable, 1); assert.equal(out.complete, false); assert.match(out.reason, /1件取得できず/)
})

test('ジョビンズ・circus も同じ読み方で全件を読む / 時間切れは「読み切れていない」扱い', async () => {
  const { jobins, circus } = await import('../lib/drivers.js')
  const f = fakeHitolink(250)
  const fake = { jobins: f.hitolink, circus: { ...f.hitolink, logout: async () => {} } }
  const db = openDb(':memory:')
  const c2 = { ...cfg, pageSize: { jobins: 100, circus: 100 }, circusOrderBy: 'publishStartedAt' }
  const s1 = new SyncSession(db, { source: 'jobins', runId: 1, cfg: c2 })
  const o1 = await jobins.run({ cfg: c2, env: {}, browser: fakeBrowser, log: () => {}, shouldStop: () => false, session: s1, adapters: fake, onPage: (x) => s1.ingest(x) })
  assert.equal(s1.stats.fetched, 250); assert.equal(o1.complete, true)
  let n = 0
  const s2 = new SyncSession(db, { source: 'jobins', runId: 2, cfg: c2 })
  const o2 = await jobins.run({ cfg: c2, env: {}, browser: fakeBrowser, log: () => {}, shouldStop: () => ++n > 2, session: s2, adapters: fake, onPage: (x) => s2.ingest(x) })
  assert.equal(o2.complete, false); assert.equal(o2.reason, '時間切れ')
})

test('ページの範囲指定: 指定範囲だけ読み、掲載終了の判定はしない', async () => {
  const db = openDb(':memory:')
  const f = fakeHitolink(1000)
  const s1 = new SyncSession(db, { source: 'hitolink', runId: 1, cfg })
  const all = await hitolink.run({ cfg, env: {}, browser: fakeBrowser, log: () => {}, shouldStop: () => false, session: s1, adapters: f, onPage: (x) => s1.ingest(x) })
  s1.finalize({ complete: all.complete, remoteTotal: all.remoteTotal })
  db.prepare(`DELETE FROM jobs WHERE source_job_id IN ('450','451','452')`).run() // 取りこぼしを再現
  const s2 = new SyncSession(db, { source: 'hitolink', runId: 2, cfg })
  const out = await hitolink.run({ cfg, env: {}, browser: fakeBrowser, log: () => {}, shouldStop: () => false, session: s2, adapters: f, pageRange: [4, 6], onPage: (x) => s2.ingest(x) })
  const fin = s2.finalize({ complete: out.complete, remoteTotal: out.remoteTotal, reason: out.reason, partialRead: true })
  assert.equal(s2.stats.fetched, 300); assert.equal(s2.stats.added, 3); assert.equal(s2.stats.unchanged, 297)
  assert.equal(fin.missing, 0); assert.equal(fin.closed, 0); assert.equal(fin.complete, false)
  assert.equal(db.prepare(`SELECT COUNT(*) n FROM jobs`).get().n, 1000)
})

test('媒体が応答しないページは時間切れで失敗扱いにし、同期全体は止まらない', async () => {
  const f = fakeHitolink(300)
  const orig = f.hitolink.apiSearch
  let hung = false
  f.hitolink.apiSearch = async (p, t, o) => {
    if (o.pageNo === 2 && o.limit === 100 && !hung) { hung = true; return new Promise(() => {}) } // 永遠に返らない
    return orig(p, t, o)
  }
  const db = openDb(':memory:')
  const c = { ...cfg, requestTimeoutMs: 300, pageRetry: 1 }
  const session = new SyncSession(db, { source: 'hitolink', runId: 1, cfg: c })
  const out = await hitolink.run({ cfg: c, env: {}, browser: fakeBrowser, log: () => {}, shouldStop: () => false, session, adapters: f, onPage: (x) => session.ingest(x) })
  assert.equal(session.stats.fetched, 300); assert.equal(out.pagesRecovered, 1); assert.equal(out.complete, true)
})
