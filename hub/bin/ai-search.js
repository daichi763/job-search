#!/usr/bin/env node
// ============================================================
// AI検索の評価用コマンド（求人DBを読み取りのみで使う。画面・稼働中のAI検索には影響しない）
//
//   node --no-warnings bin/ai-search.js --text="営業経験5年、年収500万以上、土日休み" \
//        --doc=cv:/path/職務経歴書.pdf --doc=resume:/path/履歴書.pdf \
//        --locations=東京都,神奈川県 --age=32 --education=大卒 --salaryMin=500 --features=weekend_off
//
//   主なオプション
//     --text=要望            --memo=担当者メモ
//     --doc=種類:PDFのパス    種類は resume(履歴書) / cv(職務経歴書) / other。複数指定可
//     --conditions=条件.json  条件をJSONで渡す（画面と同じ項目名）
//     --depth=standard|deep|all   一次審査にかける件数（標準2000 / 徹底8000 / 全件）
//     --precision=high|top        精査のモデル（top=最高精度モデル）
//     --cost=economy|standard|quality  費用モード（既定 standard。hub/.env の HUB_AI_COST_MODE でも指定可）
//     --top=20                提案件数
//     --out=結果.json         結果を保存（未指定なら hub/data/ai-results/ に保存）
//     --dry                   AIを呼ばず、母集団の件数とキーワードの当たり具合だけ確認
//     --compare               精査を最後まで行い、「途中で止めていたら提案がどう変わったか」を表示（精度確認用）
// ============================================================
import fs from 'node:fs'
import path from 'node:path'
import { openDb } from '../lib/db.js'
import { config, loadEnv, HUB_DIR } from '../lib/env.js'
import { runAiSearch, buildPool, criteriaToQuery } from '../lib/ai/engine.js'
import { pdfToText, maskPII, buildProfile, profileToText } from '../lib/ai/profile.js'
import { aiModels, Usage } from '../lib/ai/llm.js'


const env = loadEnv()
const cfg = config()
const args = process.argv.slice(2)
const opt = {}
const docs = []
for (const a of args) {
  if (!a.startsWith('--')) continue
  const [k, ...v] = a.slice(2).split('=')
  const val = v.join('=')
  if (k === 'doc') { const i = val.indexOf(':'); docs.push(i > 0 && !/^[A-Za-z]:\\/.test(val) ? { kind: val.slice(0, i), file: val.slice(i + 1) } : { kind: 'other', file: val }) }
  else opt[k] = v.length ? val : true
}
const list = (s) => (s ? String(s).split(',').map((x) => x.trim()).filter(Boolean) : [])
const t = () => new Date().toLocaleTimeString('ja-JP', { hour12: false })
const log = (m) => console.log(`[${t()}] ${m}`)

let criteria = {}
if (opt.conditions) criteria = JSON.parse(fs.readFileSync(opt.conditions, 'utf8'))
Object.assign(criteria, Object.fromEntries(Object.entries({
  freeText: opt.text, memo: opt.memo, age: opt.age && Number(opt.age), gender: opt.gender, education: opt.education,
  salaryMin: opt.salaryMin && Number(opt.salaryMin), topN: opt.top && Number(opt.top),
  locations: opt.locations && list(opt.locations), employment: opt.employment && list(opt.employment),
  jobCategories: opt.category && list(opt.category), features: opt.features && list(opt.features),
  sources: opt.source && list(opt.source), excludeKeys: opt.exclude && list(opt.exclude), jobKeys: opt.jobs && list(opt.jobs),
}).filter(([, v]) => v !== undefined && v !== '')))

const db = openDb(cfg.dbPath, { readonly: true })

async function main() {
  const m = aiModels(env)
  log(`モデル: 理解・精査=${m.smart}${opt.precision === 'top' ? `（精査は ${m.top}）` : ''} / 一次審査=${m.fast}（使えない場合は ${m.fallbackSmart.join('→')} / ${m.fallbackFast.join('→')}）`)

  const pool = buildPool(db, criteria)
  log(`確定条件: ${JSON.stringify(criteriaToQuery(criteria))}`)
  log(`母集団: ${pool.ids.length.toLocaleString()}件（学歴で除外 ${pool.excluded.education} / 性別で除外 ${pool.excluded.gender}）`)
  if (opt.dry) return
  const missing = docs.filter((d) => !fs.existsSync(d.file))
  if (missing.length) throw new Error(`書類が見つかりません: ${missing.map((d) => path.resolve(d.file)).join(', ')}（--doc=cv:/home/ubuntu/書類/職務経歴書.pdf のように、場所を含めて指定してください）`)

  // 書類の読み取り
  let profile = null
  const usage = new Usage()
  if (docs.length) {
    const read = []
    for (const d of docs) {
      const b64 = fs.readFileSync(d.file).toString('base64')
      const { text, pages } = await pdfToText(b64)
      const masked = maskPII(text, { names: list(opt.names) })
      read.push({ kind: d.kind, filename: path.basename(d.file), masked_text: masked })
      log(`書類を読み取りました: ${path.basename(d.file)}（${d.kind}・${pages}ページ・${text.length}文字）`)
    }
    const r = await buildProfile(env, read, { memo: criteria.memo || '', models: [m.smart, ...m.fallbackSmart], usage })
    profile = r.profile
    log(`経歴をまとめました（${r.model}）`)
    console.log('\n' + profileToText(profile) + '\n')
  }

  const runOpt = opt.compare ? { config: { earlyStop: null } } : {}
  const result = await runAiSearch(env, db, criteria, { ...runOpt,
    profile, keepScreen: true, costMode: opt.cost, depth: opt.depth || 'standard', precision: opt.precision || 'high', log,
    onProgress: (p) => { if (p.stage !== 'screen' || /終わり/.test(p.message) || (p.screened || 0) % 400 === 0) log(`${p.message}（${p.elapsedSec}秒・トークン ${p.usage.tokens.toLocaleString()}）`) },
  })

  const P = result.plan
  console.log(`\n=== AIの解釈 ===\n${P.understanding}`)
  console.log(`重視点: ${P.priorities.join(' / ')}\n避けたい: ${P.dealbreakers.join(' / ') || 'なし'}`)
  for (const a of P.angles) console.log(`  [${a.type}] ${a.label} … ${a.why}\n         キーワード: ${a.keywords.join('、')}`)

  const mark = { met: '○', unmet: '×', unknown: '？' }
  const show = (r, i) => {
    const j = r.job
    console.log(`\n${i + 1}. 【${r.score}点${r.capped ? `（AIの点数 ${r.rawScore}→上限）` : ''}】${r.angle ? `[${r.angle}] ` : ''}${j.title}`)
    console.log(`   ${j.source}:${j.source_job_id}${j.vacancy_no ? `（求人ID ${j.vacancy_no}）` : ''} / ${j.company || ''} / ${j.locations_text || ''} / 年収 ${j.salary_min ? Math.round(j.salary_min / 1e4) : '?'}〜${j.salary_max ? Math.round(j.salary_max / 1e4) : '?'}万`)
    for (const mu of r.must) console.log(`   ${mark[mu.status]} 必須: ${mu.req}${mu.evidence ? ` … ${mu.evidence}` : ''}`)
    console.log(`   理由: ${r.reason}`)
    if (r.concerns.length) console.log(`   懸念: ${r.concerns.join(' / ')}`)
    if (r.checkPoints.length) console.log(`   確認: ${r.checkPoints.join(' / ')}`)
  }
  console.log(`\n=== 提案（${result.recommended.length}件） ===`)
  result.recommended.forEach(show)
  if (result.reference.length) {
    console.log(`\n=== 参考: 内容は合うが必須要件を満たさない求人（${result.reference.length}件） ===`)
    result.reference.forEach(show)
  }
  const s = result.summary
  console.log(`\n所要 ${s.elapsedSec}秒 / 母集団 ${s.poolSize.toLocaleString()} / 一次審査 ${s.screened.toLocaleString()} / 精査 ${s.judged} / トークン ${s.usage.tokens.toLocaleString()}${s.usage.usd != null ? ` / 費用の目安 約$${s.usage.usd}（約${Math.round(s.usage.usd * 150)}円）` : ''}`)
  console.log(`モデル別: ${Object.entries(s.usage.byModel).map(([k, v]) => `${k} ${v.calls}回`).join(' / ')}`)
  console.log(`段階別: ${Object.entries(s.usage.byStage).map(([k, v]) => `${k} ${(v.input + v.output).toLocaleString()}トークン${v.usd != null ? `（約${Math.round(v.usd * 150)}円）` : ''}`).join(' / ')}`)
  console.log(`費用モード: ${s.costMode}${s.stopReason === 'enough' ? ' / 十分な候補が集まったため精査を早めに終了' : s.stopReason === 'budget' ? ' / 費用の上限で精査を終了' : ''}`)

  if (opt.compare) {
    // 実際の精査結果を使って、途中終了した場合の提案を再現し、最後まで精査した場合と比べる
    const { engineConfig, dupKey } = await import('../lib/ai/engine.js')
    const topN = Math.max(1, Math.min(100, Number(criteria.topN) || 20))
    const byId = new Map(result.judged.map((r) => [r.job.id, r]))
    const pick = (list) => {
      const seen = new Set(), out = []
      for (const r of [...list].sort((a, b) => b.score - a.score || b.rawScore - a.rawScore)) {
        const k = dupKey(r.job) || r.job.id
        if (seen.has(k)) continue
        seen.add(k)
        if (r.score >= engineConfig(env).minScore && r.eligibility !== 'unmet') out.push(r)
      }
      return out.slice(0, topN)
    }
    const full = pick(result.judged)
    console.log(`\n=== 精度確認（途中で精査を止めた場合との比較・精査 ${result.judged.length}件） ===`)
    for (const mode of ['economy']) {
      const ec = engineConfig(env, mode)
      const es = ec.earlyStop
      const target = Math.ceil(topN * es.need), minJudge = Math.ceil(topN * es.minJudge)
      const firstN = Math.max(ec.deepBatch * 4, Math.ceil(topN * ec.deepFirst)), step = Math.max(ec.deepBatch * 2, Math.ceil(topN / 2))
      let n = 0, stop = result.deepOrder.length
      for (let pos = 0; pos < result.deepOrder.length;) {
        pos += pos === 0 ? firstN : step
        n = Math.min(pos, result.deepOrder.length)
        const part = result.deepOrder.slice(0, n).map((id) => byId.get(id)).filter(Boolean)
        const good = new Set(part.filter((r) => r.eligibility !== 'unmet' && r.score >= es.good).map((r) => dupKey(r.job) || r.job.id)).size
        if (n >= minJudge && good >= target) { stop = n; break }
      }
      const early = pick(result.deepOrder.slice(0, stop).map((id) => byId.get(id)).filter(Boolean))
      const fullKeys = new Set(full.map((r) => r.job.id))
      const same = early.filter((r) => fullKeys.has(r.job.id)).length
      const missed = full.filter((r) => !early.some((e) => e.job.id === r.job.id))
      console.log(`[${mode}] 精査 ${stop}件で終了 → 提案${topN}件中 ${same}件が一致${missed.length ? ` / 外れた求人: ${missed.map((r) => `${r.score}点 ${String(r.job.title).slice(0, 30)}`).join('、')}` : ''}`)
      const top5 = full.slice(0, 5).filter((r) => early.some((e) => e.job.id === r.job.id)).length
      console.log(`         上位5件のうち ${top5}件が一致`)
    }
  }

  const out = opt.out || path.join(HUB_DIR, 'data', 'ai-results', `ai_${new Date().toISOString().replace(/[:.]/g, '-')}.json`)
  fs.mkdirSync(path.dirname(out), { recursive: true })
  const slim = (r) => ({ ...r, job: { id: r.job.id, key: `${r.job.source}:${r.job.source_job_id}`, vacancy_no: r.job.vacancy_no, title: r.job.title, company: r.job.company, url: r.job.url } })
  fs.writeFileSync(out, JSON.stringify({ criteria, profile, plan: P, summary: s, recommended: result.recommended.map(slim), reference: result.reference.map(slim), judged: result.judged.map(slim), screenLog: result.screenLog, deepOrder: result.deepOrder }, null, 2))
  console.log(`結果を保存しました: ${out}`)
}
main().catch((e) => { console.error('エラー:', e.message); process.exitCode = 1 }).finally(() => db.close())
