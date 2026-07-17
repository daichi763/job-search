// 2段階目: AI一致度スコアリング（gpt-5-mini / gpt-5-nano）
//
// トークン節約の工夫:
//  1) 機械フィルタ済みの候補だけをAIに渡す（全件は投げない）
//  2) 複数求人を1リクエストにバッチ採点（システムプロンプトの再送を削減）
//  3) 各求人は「要約された最小限のテキスト」に圧縮して渡す
//  4) フリー記述の要望が空なら preScore をそのまま採用しAIを呼ばない
//  5) 出力はJSONのみ・理由は短文に制限

import type { NormalizedJob, SearchCriteria, ScoreResult } from './types'

export interface ScorerConfig {
  apiKey: string
  baseUrl: string
  model: string // 'gpt-5-nano' | 'gpt-5-mini'
}

// 求人を採点用の最小テキストに圧縮（トークン節約の要）
function jobToBrief(job: NormalizedJob): string {
  const salary =
    job.salaryMin || job.salaryMax
      ? `年収${job.salaryMin ?? '?'}〜${job.salaryMax ?? '?'}万`
      : ''
  const parts = [
    `職種:${job.jobCategory}`,
    job.industry ? `業種:${job.industry}` : '',
    job.employment ? `雇用:${job.employment}` : '',
    job.locations.length ? `勤務地:${job.locations.join('/')}` : '',
    salary,
    job.overtime ? `残業:${job.overtime}` : '',
    job.holiday ? `休日:${job.holiday}` : '',
    // 仕事内容と必須条件は最も重要なので少し多めに（ただし圧縮）
    job.requirements ? `必須:${job.requirements.slice(0, 200)}` : '',
    job.description ? `内容:${job.description.slice(0, 400)}` : '',
  ]
  return parts.filter(Boolean).join(' / ')
}

// 検索条件を簡潔なテキストに
function criteriaToText(c: SearchCriteria): string {
  const parts = [
    c.freeText ? `【要望】${c.freeText}` : '',
    c.locations.length ? `勤務地:${c.locations.join('/')}` : '',
    c.salaryMin ? `年収${c.salaryMin}万以上` : '',
    c.employment.length ? `雇用:${c.employment.join('/')}` : '',
    c.jobCategories.length ? `職種:${c.jobCategories.join('/')}` : '',
    c.industries.length ? `業種:${c.industries.join('/')}` : '',
    c.overtimeMax ? `残業:${c.overtimeMax}希望` : '',
    c.holiday.length ? `休日:${c.holiday.join('/')}` : '',
    c.requirements ? `その他:${c.requirements}` : '',
  ]
  return parts.filter(Boolean).join(' / ')
}

const SYSTEM_PROMPT = `あなたは人材紹介のプロのキャリアアドバイザーです。求職者の要望と各求人の一致度を評価します。
複数の求人に対し、それぞれ0〜100点の一致度スコアと、30文字以内の日本語の理由を返してください。
- 要望のフリー記述(価値観・キャリア志向・働き方)を最重視する
- 勤務地/年収/雇用形態など明確な条件のミスマッチは大きく減点
- 情報が不足している項目は中立(減点しすぎない)
必ず次のJSON形式のみで出力: {"scores":[{"i":0,"score":85,"reason":"..."},...]}`

export interface BatchScoreOutput {
  results: { index: number; score: number; reason: string }[]
  tokensUsed: number
}

// OpenAI設定が揃っているか検証。未設定だと `${undefined}/chat/completions` という
// 壊れたURLになり "Invalid URL: undefined/chat/completions" という分かりにくい
// エラーになるため、原因を明示する。
function assertScorerConfig(cfg: ScorerConfig) {
  const missing: string[] = []
  if (!cfg.baseUrl || cfg.baseUrl === 'undefined') missing.push('OPENAI_BASE_URL')
  if (!cfg.apiKey || cfg.apiKey === 'undefined') missing.push('OPENAI_API_KEY')
  if (!cfg.model || cfg.model === 'undefined') missing.push('OPENAI_MODEL')
  if (missing.length) {
    throw new Error(
      `OpenAI設定が未設定です: ${missing.join(', ')}。` +
      `webapp側の環境変数(.dev.vars)を確認してください。`
    )
  }
}

// バッチ採点（1リクエストで複数求人）
export async function scoreBatch(
  cfg: ScorerConfig,
  criteria: SearchCriteria,
  jobs: NormalizedJob[]
): Promise<BatchScoreOutput> {
  if (jobs.length === 0) return { results: [], tokensUsed: 0 }
  assertScorerConfig(cfg)

  const jobLines = jobs.map((j, i) => `[${i}] ${jobToBrief(j)}`).join('\n')
  const userPrompt = `求職者の要望:\n${criteriaToText(criteria)}\n\n求人一覧(${jobs.length}件):\n${jobLines}\n\n各求人[i]の一致度を採点してJSONで返してください。`

  const res = await fetch(`${cfg.baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${cfg.apiKey}`,
    },
    body: JSON.stringify({
      model: cfg.model,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: userPrompt },
      ],
      response_format: { type: 'json_object' },
      // トークン節約: 推論を最小化（採点タスクは深い推論不要）
      reasoning_effort: 'low',
      // 出力上限（求人1件あたり約40トークン想定 × バッチ件数 + 余裕）
      max_completion_tokens: 2000,
    }),
  })

  if (!res.ok) {
    const t = await res.text()
    throw new Error(`OpenAI API error ${res.status}: ${t.slice(0, 300)}`)
  }

  const data: any = await res.json()
  const tokensUsed = data.usage?.total_tokens ?? 0
  const content = data.choices?.[0]?.message?.content ?? '{}'

  let parsed: any = {}
  try {
    parsed = JSON.parse(content)
  } catch {
    // JSONパース失敗 → preScore代替
    return {
      results: jobs.map((_, i) => ({ index: i, score: 50, reason: '採点解析失敗' })),
      tokensUsed,
    }
  }

  const scores = parsed.scores || []
  const results = jobs.map((_, i) => {
    const s = scores.find((x: any) => x.i === i || x.index === i)
    return {
      index: i,
      score: s ? Math.max(0, Math.min(100, Math.round(s.score))) : 40,
      reason: s?.reason ? String(s.reason).slice(0, 60) : '',
    }
  })

  return { results, tokensUsed }
}
