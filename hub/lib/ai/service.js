// ============================================================
// AI検索サービス（hub-ai）の中身
//   ・求職者・書類・紹介済み・AI検索の API（webapp から中継される。担当者は x-hub-user ヘッダで受け取る）
//   ・AI検索は同時に HUB_AI_MAX_PARALLEL 件（既定3件）まで実行し、それを超えた分は順番待ちにする
//     （媒体にはログインしないので、複数の担当者が同時に検索しても競合しない。上限は OpenAI の
//      利用制限とサーバーの負荷に合わせて決める）
//   ・進捗は作業DBに書き、画面は数秒おきに読みに来る
//   ・書類（PDF）は受け取ったその場で文字にして個人情報を伏せ、PDFそのものは保存しない
// ============================================================
import { runAiSearch, buildPool, criteriaToQuery } from './engine.js'
import { pdfToText, maskPII, buildProfile, profileToText } from './profile.js'
import { aiModels, Usage } from './llm.js'
import * as W from '../workspace.js'

const MAX_PDF_BYTES = 8 * 1024 * 1024
const MAX_DOCS = 10
const LIST = (v) => [].concat(v || []).flatMap((x) => String(x).split(',')).map((x) => x.trim()).filter(Boolean)
const PREFS = new Set('北海道 青森県 岩手県 宮城県 秋田県 山形県 福島県 茨城県 栃木県 群馬県 埼玉県 千葉県 東京都 神奈川県 新潟県 富山県 石川県 福井県 山梨県 長野県 岐阜県 静岡県 愛知県 三重県 滋賀県 京都府 大阪府 兵庫県 奈良県 和歌山県 鳥取県 島根県 岡山県 広島県 山口県 徳島県 香川県 愛媛県 高知県 福岡県 佐賀県 長崎県 熊本県 大分県 宮崎県 鹿児島県 沖縄県'.split(' '))
const FEATURE_KEYS = ['remote', 'flex', 'side_job', 'no_transfer', 'holidays_120', 'weekend_off', 'inexperienced_ok', 'short_time']
const SOURCE_KEYS = ['circus', 'hitolink', 'jobins', 'kintone']
const EDU = ['中卒', '高卒', '専門卒', '短大卒', '高専卒', '大卒', '大学院卒']

// 画面から来た条件を、エンジンに渡せる形に整える（想定外の値は捨てる）
export function normalizeCriteria(b = {}) {
  const num = (v, lo, hi) => { const n = Number(v); return Number.isFinite(n) && v !== '' && v != null ? Math.min(hi, Math.max(lo, n)) : null }
  const c = {
    freeText: String(b.freeText || '').slice(0, 4000),
    memo: String(b.memo || '').slice(0, 4000),
    desiredJobs: String(b.desiredJobs || '').slice(0, 300),
    locations: LIST(b.locations).filter((p) => PREFS.has(p)),
    includeNationwide: b.includeNationwide !== false,
    salaryMin: num(b.salaryMin, 0, 5000),
    age: num(b.age, 15, 80),
    gender: ['男性', '女性'].includes(b.gender) ? b.gender : '',
    education: EDU.includes(b.education) ? b.education : '',
    employment: LIST(b.employment).slice(0, 10),
    jobCategories: LIST(b.jobCategories).slice(0, 20),
    features: LIST(b.features).filter((f) => FEATURE_KEYS.includes(f)),
    sources: LIST(b.sources).filter((s) => SOURCE_KEYS.includes(s)),
    jobKeys: LIST(b.jobKeys).filter((k) => /^[a-z]+:.+/.test(k)).slice(0, 5000),
    excludeKeys: LIST(b.excludeKeys).filter((k) => /^[a-z]+:.+/.test(k)).slice(0, 1000),
    topN: num(b.topN, 1, 100) || 20,
  }
  if (c.sources.length === SOURCE_KEYS.length) c.sources = []
  return c
}

export function createService({ env, jobsDb, ws, log = console.log }) {
  const m = aiModels(env)
  const jdb = () => (typeof jobsDb === 'function' ? jobsDb() : jobsDb) // 求人DBは開き直されることがあるので毎回取り出す
  const maxParallel = Math.max(1, Math.min(10, parseInt(env.HUB_AI_MAX_PARALLEL || '3', 10) || 3))
  const running = new Set() // 実行中の検索ID

  // ---------- 経歴の作成（書類が変わったときだけ作り直す） ----------
  async function ensureProfile(candidateId, usage) {
    const hash = W.profileHash(ws, candidateId)
    if (!hash) return null
    const c = ws.prepare('SELECT profile_json, profile_hash, memo FROM candidates WHERE id=?').get(candidateId)
    if (c?.profile_json && c.profile_hash === hash) { try { return JSON.parse(c.profile_json) } catch {} }
    const docs = W.documentsForProfile(ws, candidateId)
    const r = await buildProfile(env, docs, { memo: c?.memo || '', models: [m.smart, ...m.fallbackSmart], usage })
    W.saveProfile(ws, candidateId, r.profile, hash)
    return r.profile
  }

  // ---------- 1件の検索を実行 ----------
  async function runOne(id) {
    running.add(id)
    W.markRunning(ws, id)
    const raw = W.getSearchRaw(ws, id)
    const criteria = JSON.parse(raw.criteria_json)
    const options = JSON.parse(raw.options_json || '{}')
    const logLines = []
    const t0 = Date.now()
    let lastUsage = { tokens: 0, usd: 0 }
    // 経過時間・トークン・費用の目安を各行の末尾に付ける（CLI の ai-search.js と同じ書式）
    const tail = (u = lastUsage) => `（${Math.round((Date.now() - t0) / 1000)}秒・トークン ${(u.tokens || 0).toLocaleString()}${u.usd != null ? `・約${Math.round(u.usd * 150)}円` : ''}）`
    const push = (msg, stage, { withTail = true } = {}) => {
      const line = withTail ? `${msg}${tail()}` : msg
      logLines.push({ t: new Date().toISOString(), msg: line })
      if (logLines.length > 120) logLines.shift()
      W.updateProgress(ws, id, { stage, message: line, log: logLines })
    }
    const usage = new Usage()
    try {
      let profile = null
      const md = aiModels(env)
      push(`モデル: 理解・最終判定=${options.precision === 'top' ? `${md.smart}（精査は ${md.top}）` : md.smart} / 一次審査・予備判定=${md.fast}（使えない場合は ${md.fallbackSmart.join('→')} / ${md.fallbackFast.join('→')}）`, 'plan', { withTail: false })
      if (running.size > 1) push(`同時に実行中の検索: ${running.size}件（上限 ${maxParallel}件）`, 'plan', { withTail: false })
      if (raw.candidate_id) {
        // 紹介済みの求人は自動で除外
        const refs = W.referralKeys(ws, raw.candidate_id)
        if (refs.length) criteria.excludeKeys = [...new Set([...(criteria.excludeKeys || []), ...refs])]
        if (options.useDocuments !== false && W.profileHash(ws, raw.candidate_id)) {
          push('書類から経歴を読み取っています…', 'profile')
          profile = await ensureProfile(raw.candidate_id, usage)
          if (profile) push('経歴をまとめました', 'profile')
        }
      }
      if (criteria.excludeKeys?.length) push(`紹介済みなど ${criteria.excludeKeys.length}件の求人を除外します`, 'pool', { withTail: false })
      try {
        const pool = buildPool(jdb(), criteria)
        push(`確定条件: ${JSON.stringify(criteriaToQuery(criteria))}`, 'pool', { withTail: false })
        push(`母集団: ${pool.ids.length.toLocaleString()}件（学歴で除外 ${pool.excluded.education.toLocaleString()} / 性別で除外 ${pool.excluded.gender.toLocaleString()}）`, 'pool', { withTail: false })
      } catch (e) { log(`[hub-ai] ${id} 母集団の事前集計に失敗: ${e.message}`) }
      const result = await runAiSearch(env, jdb(), criteria, {
        profile, costMode: options.costMode, depth: options.depth || 'standard', precision: options.precision === 'top' ? 'top' : 'high',
        isCancelled: () => W.cancelRequested(ws, id),
        onProgress: (p) => {
          if (p.usage) lastUsage = { tokens: p.usage.tokens + (usage.tokens || 0), usd: p.usage.usd == null ? null : p.usage.usd + (usage.usd || 0) }
          // 一次審査は400件ごと、予備判定は30件ごとに経過へ残す（それ以外は「現在の状況」だけ更新）
          const quiet = (p.stage === 'screen' && p.screened != null && !/終わり/.test(p.message) && p.screened % 400 !== 0) ||
                        (p.preJudging != null && p.preJudging % 30 !== 0 && p.preJudging !== p.preTotal)
          if (quiet) { W.updateProgress(ws, id, { stage: p.stage, message: `${p.message}${tail()}` }); return }
          if (p.stage === 'done') return // 完了の行は、書類の読み取り費用も合わせて最後に1回だけ出す
          push(p.message, p.stage)
          if (p.plan) W.updateProgress(ws, id, { plan: p.plan })
        },
        log: (msg) => push(msg, undefined, { withTail: false }),
      })
      const cancelled = W.cancelRequested(ws, id)
      // 書類の読み取りの費用も合算
      const total = (result.summary.usage.usd ?? 0) + (usage.usd ?? 0)
      const summary = { ...result.summary, profileUsd: usage.usd, totalUsd: Math.round(total * 1000) / 1000, hasProfile: !!profile, excluded: criteria.excludeKeys?.length || 0 }
      W.finishSearch(ws, id, { status: cancelled ? 'cancelled' : 'done', result, usd: summary.totalUsd, summary })
      lastUsage = { tokens: (result.summary.usage.tokens || 0) + (usage.tokens || 0), usd: total }
      push(cancelled ? `中止しました（それまでの結果 ${result.recommended.length}件）` : `完了: ${result.recommended.length}件を提案`, 'done')
      log(`[hub-ai] ${id} ${cancelled ? 'cancelled' : 'done'} rec=${result.recommended.length} usd=${summary.totalUsd} ${result.summary.elapsedSec}s`)
    } catch (e) {
      log(`[hub-ai] ${id} error: ${e.stack || e.message}`)
      W.finishSearch(ws, id, { status: 'error', error: String(e.message || e).slice(0, 500), usd: usage.usd ?? null, summary: null })
      push(`エラー: ${e.message}`, 'done')
    } finally {
      running.delete(id)
      setImmediate(() => tick().catch(() => {}))
    }
  }

  // ---------- 順番待ちを1件ずつ処理 ----------
  //   空きがあれば、順番待ちの古いものから開始する（終わるのは待たない）
  let ticking = false
  async function tick() {
    if (ticking) return
    ticking = true
    try {
      while (running.size < maxParallel) {
        const id = W.nextQueued(ws, [...running])
        if (!id) break
        runOne(id).catch((e) => log(`[hub-ai] ${id} runOne: ${e.message}`))
      }
    } finally { ticking = false }
  }
  // テスト用: 実行中の検索がすべて終わるまで待つ
  async function drain() {
    await tick()
    while (running.size) { await new Promise((r) => setTimeout(r, 10)); await tick() }
  }
  const recovered = W.recoverInterrupted(ws)
  if (recovered) log(`[hub-ai] 再起動で中断された検索 ${recovered}件を「中断」にしました`)
  const timer = setInterval(() => { tick().catch((e) => log(`[hub-ai] tick: ${e.message}`)) }, 2000)
  timer.unref?.()

  // ---------- API ----------
  //   req: { method, path, query(URLSearchParams), body(object), user({id,name,role}) }
  //   戻り値: { status, body }
  async function handle(req) {
    const { method, path, query, body = {}, user } = req
    const ok = (b) => ({ status: 200, body: b })
    const bad = (msg, st = 400) => ({ status: st, body: { ok: false, error: msg } })
    let mm

    // 求職者
    if (path === '/candidates' && method === 'GET') {
      return ok(W.listCandidates(ws, { q: query.get('q') || '', owner: query.get('mine') === '1' ? user?.id : null, limit: Number(query.get('limit') || 50), offset: Number(query.get('offset') || 0), archived: query.get('archived') === '1' }))
    }
    if (path === '/candidates' && method === 'POST') {
      const r = W.createCandidate(ws, body, user)
      return r.ok ? ok(r) : bad(r.error)
    }
    if ((mm = path.match(/^\/candidates\/(\d+)$/))) {
      const id = Number(mm[1])
      if (method === 'GET') { const c = W.getCandidate(ws, id); return c ? ok(c) : bad('求職者が見つかりません', 404) }
      if (method === 'PATCH') { const r = W.updateCandidate(ws, id, body); return r.ok ? ok(r) : bad(r.error) }
      if (method === 'DELETE') {
        if (user?.role !== 'admin') return bad('求職者の完全な削除は管理者だけができます（担当者は「アーカイブ」を使ってください）', 403)
        const r = W.deleteCandidate(ws, id); return r.ok ? ok(r) : bad(r.error, 404)
      }
    }
    // 書類（PDFを受け取り、その場で文字にして個人情報を伏せる。PDFは保存しない）
    if ((mm = path.match(/^\/candidates\/(\d+)\/documents$/)) && method === 'POST') {
      const id = Number(mm[1])
      const c = ws.prepare('SELECT id, name, name_kana FROM candidates WHERE id=?').get(id)
      if (!c) return bad('求職者が見つかりません', 404)
      const count = ws.prepare('SELECT COUNT(*) AS n FROM candidate_documents WHERE candidate_id=?').get(id).n
      if (count >= MAX_DOCS) return bad(`書類は1人あたり${MAX_DOCS}件までです`)
      const b64 = String(body.pdfBase64 || '')
      if (!b64) return bad('PDFを選んでください')
      if (b64.length * 0.75 > MAX_PDF_BYTES) return bad('PDFが大きすぎます（8MBまで）')
      let text, pages
      try { ({ text, pages } = await pdfToText(b64)) } catch (e) { return bad(e.message) }
      const masked = maskPII(text, { names: [c.name, c.name_kana, ...LIST(body.names)].filter(Boolean) })
      const docId = W.addDocument(ws, id, { kind: body.kind, filename: body.filename, masked_text: masked, pages }, user)
      return ok({ ok: true, id: docId, pages, chars: masked.length, preview: masked.slice(0, 400) })
    }
    if ((mm = path.match(/^\/candidates\/(\d+)\/documents\/(\d+)$/)) && method === 'DELETE') {
      return W.deleteDocument(ws, mm[1], mm[2]) ? ok({ ok: true }) : bad('書類が見つかりません', 404)
    }
    if ((mm = path.match(/^\/candidates\/(\d+)\/documents\/(\d+)$/)) && method === 'GET') {
      const d = ws.prepare('SELECT id, kind, filename, masked_text, pages, created_at FROM candidate_documents WHERE id=? AND candidate_id=?').get(Number(mm[2]), Number(mm[1]))
      return d ? ok(d) : bad('書類が見つかりません', 404)
    }
    // 経歴の読み取り（書類を追加した後に、検索前に確認したいとき）
    if ((mm = path.match(/^\/candidates\/(\d+)\/profile$/)) && method === 'POST') {
      const id = Number(mm[1])
      if (!W.profileHash(ws, id)) return bad('書類がありません')
      const usage = new Usage()
      try {
        const p = await ensureProfile(id, usage)
        return ok({ ok: true, profile: p, text: profileToText(p), usd: usage.usd })
      } catch (e) { return bad(`経歴の読み取りに失敗しました: ${e.message}`, 502) }
    }
    // 紹介済み
    if ((mm = path.match(/^\/candidates\/(\d+)\/referrals$/))) {
      const id = Number(mm[1])
      if (method === 'POST') { const r = W.addReferral(ws, id, body, user); return r.ok ? ok(r) : bad(r.error) }
      if (method === 'DELETE') return W.deleteReferral(ws, id, query.get('job_key') || body.job_key) ? ok({ ok: true }) : bad('見つかりません', 404)
    }

    // AI検索
    if (path === '/searches' && method === 'POST') {
      const criteria = normalizeCriteria(body.criteria || {})
      const candidateId = body.candidateId ? Number(body.candidateId) : null
      if (candidateId && !ws.prepare('SELECT id FROM candidates WHERE id=?').get(candidateId)) return bad('求職者が見つかりません', 404)
      if (!criteria.freeText && !criteria.memo && !criteria.jobKeys.length && !(candidateId && W.profileHash(ws, candidateId))) {
        return bad('要望を入力するか、書類を登録してください')
      }
      const options = {
        costMode: ['economy', 'standard', 'quality'].includes(body.options?.costMode) ? body.options.costMode : undefined,
        depth: ['standard', 'deep', 'all'].includes(body.options?.depth) ? body.options.depth : 'standard',
        precision: body.options?.precision === 'top' ? 'top' : 'high',
        useDocuments: body.options?.useDocuments !== false,
      }
      if (candidateId) W.saveConditions(ws, candidateId, { ...criteria, options })
      const id = W.createSearch(ws, { candidateId, user, criteria, options })
      setImmediate(() => tick().catch(() => {}))
      return ok({ ok: true, id })
    }
    if (path === '/searches' && method === 'GET') {
      return ok(W.listSearches(ws, { candidateId: query.get('candidate'), userId: query.get('mine') === '1' ? user?.id : null, limit: Number(query.get('limit') || 50), offset: Number(query.get('offset') || 0) }))
    }
    if ((mm = path.match(/^\/searches\/([\w-]+)$/)) && method === 'GET') {
      const s = W.getSearch(ws, mm[1], { withResults: query.get('results') !== '0' })
      if (s) addRewards(s)
      return s ? ok(s) : bad('検索が見つかりません', 404)
    }
    if ((mm = path.match(/^\/searches\/([\w-]+)\/cancel$/)) && method === 'POST') {
      const r = W.requestCancel(ws, mm[1]); return r.ok ? ok(r) : bad(r.error)
    }
    if (path === '/status' && method === 'GET') {
      const q = ws.prepare(`SELECT COUNT(*) AS n FROM ai_searches WHERE status='queued'`).get().n
      return ok({ running: [...running], runningCount: running.size, maxParallel, queued: q, models: { smart: m.smart, fast: m.fast } })
    }
    return bad('not_found', 404)
  }

  // 紹介報酬を保存していない以前の検索結果には、求人DBから補う（掲載終了で消えた求人は補えない）
  function addRewards(s) {
    const need = [...(s.recommended || []), ...(s.reference || [])].filter((r) => r.reward_type === undefined && r.source && r.source_job_id)
    if (!need.length) return
    let st
    try { st = jdb().prepare('SELECT reward_type, reward_rate, reward_amount, reward_text FROM jobs WHERE source=? AND source_job_id=?') } catch { return }
    for (const r of need) {
      const j = st.get(r.source, String(r.source_job_id))
      if (!j) continue
      r.reward_type = j.reward_type || null; r.reward_rate = j.reward_rate ?? null; r.reward_amount = j.reward_amount ?? null
      if (!r.reward) r.reward = j.reward_text || null
    }
  }

  return { handle, tick, drain, close: () => clearInterval(timer), get running() { return [...running] }, maxParallel }
}
