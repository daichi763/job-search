// ============================================================
// OpenAI 呼び出し（AI検索用）
//   ・モデルは hub/.env で切り替え（未設定なら最新世代の既定値）
//       HUB_AI_MODEL_SMART  … 要望の理解・書類の読み取り・最終判定（既定 gpt-6.1-sol）
//       HUB_AI_MODEL_TOP    … 「最高精度」を選んだときの最終判定（既定 gpt-6-astra）
//       HUB_AI_MODEL_FAST   … 大量の一次審査（既定 gpt-6-luna）
//   ・そのモデルが使えない（契約・提供状況）ときは HUB_AI_FALLBACK_MODELS の順に自動で切り替える
//   ・一時的なエラー（429 / 5xx / 通信切れ）は待って再試行する
//   ・使ったトークン数と費用の目安を集計する
// ============================================================

// 1Mトークンあたりの料金（米ドル）[入力, キャッシュ済み入力, 出力]。費用の目安の表示にだけ使う
//   同じ前置き（要望・経歴）を繰り返し送るため、2回目以降はキャッシュ料金になることが多い
const PRICES = {
  'gpt-6-astra': [10, 1, 50], 'gpt-6.1-sol': [2, 0.1, 10], 'gpt-6-sol': [2, 0.1, 10], 'gpt-6-luna': [0.1, 0.01, 0.5],
  'gpt-5.6-sol': [4, 0.4, 20], 'gpt-5.6': [4, 0.4, 20],
  'gpt-5.5': [5, 0.5, 30], 'gpt-5.4': [2.5, 0.25, 15], 'gpt-5.2': [1.75, 0.175, 14], 'gpt-5.1': [1.25, 0.125, 10], 'gpt-5': [1.25, 0.125, 10],
  'gpt-5-mini': [0.25, 0.025, 2], 'gpt-5-nano': [0.05, 0.005, 0.4],
}
// 推論の深さ（reasoning_effort）を指定できないモデル（none / minimal 非対応など）の補正
const NO_NONE = /^gpt-6-astra|^gpt-6\.1-sol/

export function aiModels(env) {
  const list = (s) => String(s || '').split(',').map((x) => x.trim()).filter(Boolean)
  return {
    smart: env.HUB_AI_MODEL_SMART || 'gpt-6.1-sol',
    top: env.HUB_AI_MODEL_TOP || 'gpt-6-astra',
    fast: env.HUB_AI_MODEL_FAST || 'gpt-6-luna',
    write: env.HUB_AI_MODEL_WRITE || '',   // 推薦文（未設定なら smart と同じ）
    fallbackSmart: list(env.HUB_AI_FALLBACK_MODELS || 'gpt-5.5,gpt-5.2,gpt-5'),
    fallbackFast: list(env.HUB_AI_FALLBACK_FAST_MODELS || 'gpt-5-mini,gpt-5-nano'),
  }
}

export class Usage {
  constructor() { this.byModel = {}; this.byStage = {}; this.calls = 0 }
  add(model, u, stage = 'その他') {
    const input = u?.prompt_tokens || u?.input_tokens || 0
    const cached = u?.prompt_tokens_details?.cached_tokens || u?.input_tokens_details?.cached_tokens || 0
    const output = u?.completion_tokens || u?.output_tokens || 0
    for (const m of [(this.byModel[model] ||= { input: 0, cached: 0, output: 0, calls: 0 }), (this.byStage[stage] ||= { input: 0, cached: 0, output: 0, calls: 0, usd: 0, models: {} })]) {
      m.input += input; m.cached += cached; m.output += output; m.calls++
    }
    const st = this.byStage[stage]
    st.models[model] = (st.models[model] || 0) + 1
    const c = costOf(model, input, cached, output)
    st.usd = st.usd == null || c == null ? null : st.usd + c
    this.calls++
  }
  get tokens() { return Object.values(this.byModel).reduce((a, m) => a + m.input + m.output, 0) }
  get usd() {
    let t = 0
    for (const [model, m] of Object.entries(this.byModel)) {
      const c = costOf(model, m.input, m.cached, m.output)
      if (c == null) return null
      t += c
    }
    return t
  }
  summary() {
    const r3 = (v) => (v == null ? null : Math.round(v * 1000) / 1000)
    const byStage = Object.fromEntries(Object.entries(this.byStage).map(([k, v]) => [k, { ...v, usd: r3(v.usd) }]))
    return { tokens: this.tokens, calls: this.calls, usd: r3(this.usd), byModel: this.byModel, byStage }
  }
}
function costOf(model, input, cached, output) {
  const p = PRICES[model] || PRICES[String(model).replace(/-\d{4}-\d{2}-\d{2}$/, '')]
  if (!p) return null
  return ((input - cached) * p[0] + cached * p[1] + output * p[2]) / 1e6
}

// 使えないと分かったモデル（プロセスが動いている間は覚えておき、毎回試さない）
const unavailable = new Set()
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// 送信できない文字（孤立したサロゲート・制御文字）を取り除く
export function sanitize(str) {
  if (str == null) return ''
  const s = String(str)
  let out = ''
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i)
    if (c <= 0x08 || c === 0x0B || c === 0x0C || (c >= 0x0E && c <= 0x1F) || c === 0x7F) { out += ' '; continue }
    if (c >= 0xD800 && c <= 0xDBFF) {
      const n = s.charCodeAt(i + 1)
      if (n >= 0xDC00 && n <= 0xDFFF) { out += s[i] + s[i + 1]; i++ }
      continue
    }
    if (c >= 0xDC00 && c <= 0xDFFF) continue
    out += s[i]
  }
  return out
}

function parseJson(text) {
  if (!text) return null
  try { return JSON.parse(text) } catch {}
  const m = String(text).match(/\{[\s\S]*\}/)
  if (m) { try { return JSON.parse(m[0]) } catch {} }
  return null
}

// JSONで答えさせる呼び出し。models は試す順（先頭が第一候補）
export async function chatJson(env, { models, system, user, effort = 'low', maxTokens = 4000, usage, timeoutMs = 240000, label = '', stage }) {
  const base = (env.HUB_AI_BASE_URL || env.OPENAI_BASE_URL || 'https://api.openai.com/v1').replace(/\/$/, '')
  const key = env.HUB_AI_API_KEY || env.OPENAI_API_KEY
  if (!key) throw new Error('OpenAI のAPIキー（OPENAI_API_KEY）が設定されていません')
  const tryModels = [...new Set(models)].filter((m) => !unavailable.has(m))
  if (!tryModels.length) tryModels.push(models[models.length - 1])
  let lastErr
  for (const model of tryModels) {
    let eff = effort
    if (NO_NONE.test(model) && (eff === 'none' || eff === 'minimal')) eff = 'low'
    if (/^gpt-5(-mini|-nano)?$/.test(model) && eff === 'none') eff = 'minimal'
    for (let attempt = 0; attempt < 4; attempt++) {
      const body = {
        model,
        messages: [{ role: 'system', content: sanitize(system) }, { role: 'user', content: sanitize(user) }],
        response_format: { type: 'json_object' },
        reasoning_effort: eff,
        max_completion_tokens: maxTokens,
      }
      let res, text
      try {
        res = await fetch(`${base}/chat/completions`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(timeoutMs),
        })
        text = await res.text()
      } catch (e) {
        lastErr = new Error(`${model}: 通信エラー ${e.message}`)
        await sleep(3000 * (attempt + 1))
        continue
      }
      if (res.ok) {
        let data
        try { data = JSON.parse(text) } catch { lastErr = new Error(`${model}: 応答を読めません`); continue }
        usage?.add(model, data.usage, stage || label || 'その他')
        const content = data.choices?.[0]?.message?.content
        const parsed = parseJson(content)
        if (parsed) return { data: parsed, model }
        // 出力が途中で切れた等。もう1回だけ同じモデルで試す
        lastErr = new Error(`${model}: JSONを読めません（${data.choices?.[0]?.finish_reason || '?'}）`)
        if (attempt >= 1) break
        continue
      }
      const msg = text.slice(0, 300)
      // モデルが無い・使えない → 次のモデルへ
      if (res.status === 404 || (res.status === 400 && /model|does not exist|not found|unsupported|not supported|access/i.test(msg)) || res.status === 403) {
        if (res.status === 400 && /reasoning_effort/i.test(msg) && eff !== 'low') { eff = 'low'; continue }
        unavailable.add(model)
        console.warn(`[ai] モデル ${model} が使えないため次の候補に切り替えます: ${res.status} ${msg.slice(0, 160)}`)
        lastErr = new Error(`${model}: ${res.status} ${msg}`)
        break
      }
      lastErr = new Error(`${model}: ${res.status} ${msg}`)
      if (res.status === 429 || res.status >= 500) { await sleep(Math.min(60000, 5000 * 2 ** attempt)); continue }
      break // そのほかの 400 系はやり直しても同じ
    }
  }
  throw new Error(`AI呼び出しに失敗しました${label ? `（${label}）` : ''}: ${lastErr?.message || '不明'}`)
}

// 同時にいくつまで走らせるかを決めて、配列を順に処理する
export async function mapLimit(items, limit, fn) {
  const out = new Array(items.length)
  let next = 0
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++
      out[i] = await fn(items[i], i)
    }
  })
  await Promise.all(workers)
  return out
}

export const _test = { parseJson, PRICES, unavailable }
