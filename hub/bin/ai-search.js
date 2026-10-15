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
//     --compare               候補の全件を賢いモデルでも判定し、「2段階の精査（安いモデルで予備判定→上位だけ最終判定）」と提案がどう違うかを表示（精度確認用・費用は増える）
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
  log(`モデル: 理解・最終判定=${m.smart}${opt.precision === 'top' ? `（精査は ${m.top}）` : ''} / 一次審査・予備判定=${m.fast}（使えない場合は ${m.fallbackSmart.join('→')} / ${m.fallbackFast.join('→')}）`)

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

  const runOpt = opt.compare ? { config: { earlyStop: null, comparePre: true } } : {}
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
  console.log(`\n所要 ${s.elapsedSec}秒 / 母集団 ${s.poolSize.toLocaleString()} / 一次審査 ${s.screened.toLocaleString()} / 精査 ${s.preJudged ? `予備${s.preJudged}→最終${s.finalJudged}` : s.judged} / トークン ${s.usage.tokens.toLocaleString()}${s.usage.usd != null ? ` / 費用の目安 約$${s.usage.usd}（約${Math.round(s.usage.usd * 150)}円）` : ''}`)
  console.log(`モデル別: ${Object.entries(s.usage.byModel).map(([k, v]) => `${k} ${v.calls}回`).join(' / ')}`)
  console.log(`段階別: ${Object.entries(s.usage.byStage).map(([k, v]) => `${k} ${(v.input + v.output).toLocaleString()}トークン${v.usd != null ? `（約${Math.round(v.usd * 150)}円）` : ''}`).join(' / ')}`)
  console.log(`費用モード: ${s.costMode}${s.stopReason === 'enough' ? ' / 十分な候補が集まったため精査を早めに終了' : s.stopReason === 'budget' ? ' / 費用の上限で精査を終了' : ''}`)

  if (opt.compare && result.preJudged?.length) {
    // 全件を賢いモデルで判定した結果を基準に、「安いモデルの予備判定で上位だけ残した場合」の提案を再現して比べる
    const { engineConfig, dupKey } = await import('../lib/ai/engine.js')
    const topN = Math.max(1, Math.min(100, Number(criteria.topN) || 20))
    const minScore = engineConfig(env).minScore
    const pick = (list) => {
      const seen = new Set(), out = []
      for (const r of [...list].sort((a, b) => b.score - a.score || b.rawScore - a.rawScore)) {
        const k = dupKey(r.job) || r.job.id
        if (seen.has(k)) continue
        seen.add(k)
        if (r.score >= minScore && r.eligibility !== 'unmet') out.push(r)
      }
      return out.slice(0, topN)
    }
    const full = pick(result.judged)
    const pre = result.preJudged
    console.log(`\n=== 精度確認（全件を ${m.smart} で判定した場合と、2段階で判定した場合の比較・候補 ${result.judged.length}件） ===`)
    // 比較のために全件を優秀モデルで判定しているので、上の費用は通常より高い。通常の実行での費用を見積もる
    const fin = s.usage.byStage['精査（判定）']
    if (fin?.usd != null && s.usage.usd != null) {
      const est = (mode) => {
        const n = Math.min(result.judged.length, Math.ceil(topN * engineConfig(env, mode).finalFactor))
        return s.usage.usd - fin.usd * (1 - n / result.judged.length)
      }
      console.log(`※上の費用は比較のため全件を優秀モデルで判定した分を含みます。--compare なしの見込み: standard 約${Math.round(est('standard') * 150)}円 / economy 約${Math.round(est('economy') * 150)}円`)
    }
    for (const mode of ['economy', 'standard']) {
      const f = engineConfig(env, mode).finalFactor
      const n = Math.ceil(topN * f)
      const ranked = [...pre].sort((a, b) => (a.eligibility === 'unmet') - (b.eligibility === 'unmet') || b.rawScore - a.rawScore)
      const seen = new Set(), keep = new Set()
      for (const r of ranked) { const k = dupKey(r.job) || r.job.id; if (seen.has(k)) continue; seen.add(k); keep.add(r.job.id); if (keep.size >= n) break }
      const got = new Set(pre.map((r) => r.job.id))
      const two = pick(result.judged.filter((r) => keep.has(r.job.id) || !got.has(r.job.id)))
      const same = two.filter((r) => full.some((x) => x.job.id === r.job.id)).length
      // 同じ点数の求人が入れ替わっただけのものは「取りこぼし」に数えない
      const floor = two.length >= full.length ? Math.min(...two.map((r) => r.score)) : -1
      const missed = full.filter((r) => !two.some((e) => e.job.id === r.job.id))
      const real = missed.filter((r) => r.score > floor)
      const loss = full.reduce((a, r) => a + r.score, 0) - two.reduce((a, r) => a + r.score, 0)
      console.log(`[${mode}] 上位${n}件を最終判定 → 提案${full.length}件中 ${same}件が同じ求人${missed.length - real.length ? `（${missed.length - real.length}件は同点の求人との入れ替え）` : ''} / 取りこぼし ${real.length}件${real.length ? `: ${real.map((r) => `${r.score}点 ${String(r.job.title).slice(0, 30)}`).join('、')}` : ''} / 提案の合計点の差 ${loss}点`)
    }
  }

  const out = opt.out || path.join(HUB_DIR, 'data', 'ai-results', `ai_${new Date().toISOString().replace(/[:.]/g, '-')}.json`)
  fs.mkdirSync(path.dirname(out), { recursive: true })
  const slim = (r) => ({ ...r, job: { id: r.job.id, key: `${r.job.source}:${r.job.source_job_id}`, vacancy_no: r.job.vacancy_no, title: r.job.title, company: r.job.company, url: r.job.url } })
  fs.writeFileSync(out, JSON.stringify({ criteria, profile, plan: P, summary: s, recommended: result.recommended.map(slim), reference: result.reference.map(slim), judged: result.judged.map(slim), preJudged: result.preJudged?.map(slim), screenLog: result.screenLog, deepOrder: result.deepOrder }, null, 2))
  console.log(`結果を保存しました: ${out}`)
}
main().catch((e) => { console.error('エラー:', e.message); process.exitCode = 1 }).finally(() => db.close())
