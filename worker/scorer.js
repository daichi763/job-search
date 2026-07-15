// AIスコアリング（Cloudflare側 src/lib/scorer.ts のNode版）
function jobToBrief(job) {
  const salary = job.salaryMin || job.salaryMax ? `年収${job.salaryMin ?? '?'}〜${job.salaryMax ?? '?'}万` : ''
  return [
    `職種:${job.jobCategory || ''}`,
    job.industry ? `業種:${job.industry}` : '',
    job.employment ? `雇用:${job.employment}` : '',
    (job.locations || []).length ? `勤務地:${job.locations.join('/')}` : '',
    salary,
    job.overtime ? `残業:${job.overtime}` : '',
    job.holiday ? `休日:${job.holiday}` : '',
    job.requirements ? `必須:${String(job.requirements).slice(0, 200)}` : '',
    job.description ? `内容:${String(job.description).slice(0, 400)}` : '',
  ].filter(Boolean).join(' / ')
}

function criteriaToText(c) {
  return [
    c.freeText ? `【要望】${c.freeText}` : '',
    (c.locations || []).length ? `勤務地:${c.locations.join('/')}` : '',
    c.salaryMin ? `年収${c.salaryMin}万以上` : '',
    (c.employment || []).length ? `雇用:${c.employment.join('/')}` : '',
    (c.jobCategories || []).length ? `職種:${c.jobCategories.join('/')}` : '',
    c.overtimeMax ? `残業:${c.overtimeMax}希望` : '',
    (c.holiday || []).length ? `休日:${c.holiday.join('/')}` : '',
  ].filter(Boolean).join(' / ')
}

const SYSTEM = `あなたは人材紹介のプロのキャリアアドバイザーです。求職者の要望と各求人の一致度を評価します。
複数の求人に対し、それぞれ0〜100点の一致度スコアと、30文字以内の日本語の理由を返してください。
- 要望のフリー記述(価値観・キャリア志向・働き方)を最重視する
- 勤務地/年収/雇用形態など明確な条件のミスマッチは大きく減点
- 情報が不足している項目は中立
必ず次のJSON形式のみで出力: {"scores":[{"i":0,"score":85,"reason":"..."},...]}`

export async function scoreBatch(env, criteria, jobs) {
  if (!jobs.length) return { results: [], tokensUsed: 0 }
  const lines = jobs.map((j, i) => `[${i}] ${jobToBrief(j)}`).join('\n')
  const user = `求職者の要望:\n${criteriaToText(criteria)}\n\n求人一覧(${jobs.length}件):\n${lines}\n\n各求人[i]の一致度を採点してJSONで返してください。`

  const res = await fetch(`${env.OPENAI_BASE_URL}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${env.OPENAI_API_KEY}` },
    body: JSON.stringify({
      model: env.OPENAI_MODEL || 'gpt-5-nano',
      messages: [{ role: 'system', content: SYSTEM }, { role: 'user', content: user }],
      response_format: { type: 'json_object' },
      reasoning_effort: 'low',
      max_completion_tokens: 2000,
    }),
  })
  if (!res.ok) throw new Error(`OpenAI ${res.status}: ${(await res.text()).slice(0, 200)}`)
  const data = await res.json()
  const tokensUsed = data.usage?.total_tokens ?? 0
  let parsed = {}
  try { parsed = JSON.parse(data.choices?.[0]?.message?.content ?? '{}') } catch {}
  const scores = parsed.scores || []
  const results = jobs.map((_, i) => {
    const s = scores.find((x) => x.i === i || x.index === i)
    return { index: i, score: s ? Math.max(0, Math.min(100, Math.round(s.score))) : 40, reason: s?.reason ? String(s.reason).slice(0, 60) : '' }
  })
  return { results, tokensUsed }
}
