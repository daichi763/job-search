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

// 詳細ページ取得済み(job.detail)の求人を、精読用フル情報テキストに変換。
// ユーザー指定の優先度を明示: 勤務地/年齢/性別/学歴=確度が高い / 職種・未経験タグ=不正確。
function jobToFull(job) {
  const d = job.detail
  if (!d) return jobToBrief(job) // 詳細未取得ならブリーフ版
  const age =
    d.ageMin || d.ageMax
      ? `年齢:${d.ageMin ?? '?'}〜${d.ageMax ?? '?'}歳`
      : d.ageText
      ? `年齢:${d.ageText}`
      : ''
  const salary =
    d.salaryMin || d.salaryMax ? `年収:${d.salaryMin ?? '?'}〜${d.salaryMax ?? '?'}万` : ''
  return [
    job.title ? `タイトル:${String(job.title).slice(0, 80)}` : '',
    job.company ? `企業:${job.company}` : '',
    // --- 確度が高い情報（重視）---
    (d.locations || []).length ? `[確]勤務地:${d.locations.join('/')}` : '',
    age ? `[確]${age}` : '',
    d.gender ? `[確]性別:${d.gender}` : '',
    d.education ? `[確]学歴:${d.education}` : '',
    d.nationality ? `[確]国籍:${d.nationality}` : '',
    salary ? `[確]${salary}` : '',
    d.mustRequirements ? `[確]必須要件:${String(d.mustRequirements).replace(/\s+/g, ' ').slice(0, 300)}` : '',
    // --- 参考（不正確な場合あり）---
    d.jobCategory ? `[参考]職種:${String(d.jobCategory).slice(0, 80)}` : '',
    d.uncertainTags && d.uncertainTags.length ? `[参考]未経験タグ:${d.uncertainTags.join(',')}` : '',
    d.jobContent ? `仕事内容:${String(d.jobContent).replace(/\s+/g, ' ').slice(0, 700)}` : '',
    d.prPoint ? `PR:${String(d.prPoint).replace(/\s+/g, ' ').slice(0, 300)}` : '',
    d.holiday ? `休日:${String(d.holiday).replace(/\s+/g, ' ').slice(0, 200)}` : '',
  ]
    .filter(Boolean)
    .join(' / ')
}

const SYSTEM = `あなたは人材紹介のプロのキャリアアドバイザーです。求職者の要望と各求人の一致度を評価します。
複数の求人に対し、それぞれ0〜100点の一致度スコアと、30文字以内の日本語の理由を返してください。
【最重要】要望のフリー記述(価値観・キャリア志向・働き方)を最重視する。
【情報の確度による重み付け】
- 「[確]」が付いた項目（勤務地・年齢・性別・学歴・国籍・年収・必須要件）は確度が高い揺るぎない情報。
  これらが要望と明確にミスマッチ（例: 年齢制限外、勤務地が合わない、必須資格を満たさない）なら大きく減点する。
- 「[参考]」が付いた項目（職種名・未経験可タグ）は不正確な場合が多い。参考程度に留め、これだけで大きく増減点しない。
- 情報が不足している項目は中立。
必ず次のJSON形式のみで出力: {"scores":[{"i":0,"score":85,"reason":"..."},...]}`

export async function scoreBatch(env, criteria, jobs) {
  if (!jobs.length) return { results: [], tokensUsed: 0 }
  const lines = jobs.map((j, i) => `[${i}] ${jobToFull(j)}`).join('\n')
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

// ------------------------------------------------------------
// 1次粗選別（安く大量に）
// タイトル＋職種＋勤務地＋給与だけの最小情報で採点し、理由は返さない。
// 1件あたりのトークンを最小化し、数百件を数バッチで捌く。
// ここで一定スコア以上だけを2次（scoreBatch＝全文精読）に送る。
// ------------------------------------------------------------
function jobToTiny(job) {
  const salary = job.salaryMin || job.salaryMax ? `年収${job.salaryMin ?? '?'}〜${job.salaryMax ?? '?'}` : ''
  return [
    job.title ? String(job.title).slice(0, 80) : '',
    job.jobCategory ? `職種:${String(job.jobCategory).slice(0, 40)}` : '',
    (job.locations || []).length ? `地:${job.locations.join('/')}` : '',
    salary,
  ].filter(Boolean).join(' / ')
}

const SYSTEM_BRIEF = `あなたは人材紹介のプロです。求職者の要望と各求人の一致度を「ざっくり」0〜100で採点します。
これは1次粗選別です。要望のフリー記述(価値観・志向・働き方)と各求人の相性を、限られた情報から推測して採点してください。
情報が少ない求人でも、要望に合いそうなら高め、明確に外れていれば低めに。理由は不要。
必ず次のJSON形式のみ: {"scores":[{"i":0,"score":72},...]}`

export async function scoreBriefBatch(env, criteria, jobs) {
  if (!jobs.length) return { results: [], tokensUsed: 0 }
  const lines = jobs.map((j, i) => `[${i}] ${jobToTiny(j)}`).join('\n')
  const user = `求職者の要望:\n${criteriaToText(criteria)}\n\n求人一覧(${jobs.length}件):\n${lines}\n\n各求人[i]をざっくり採点しJSONで返してください。`

  const res = await fetch(`${env.OPENAI_BASE_URL}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${env.OPENAI_API_KEY}` },
    body: JSON.stringify({
      model: env.OPENAI_MODEL || 'gpt-5-nano',
      messages: [{ role: 'system', content: SYSTEM_BRIEF }, { role: 'user', content: user }],
      response_format: { type: 'json_object' },
      reasoning_effort: 'minimal',
      max_completion_tokens: 1500,
    }),
  })
  if (!res.ok) throw new Error(`OpenAI(brief) ${res.status}: ${(await res.text()).slice(0, 200)}`)
  const data = await res.json()
  const tokensUsed = data.usage?.total_tokens ?? 0
  let parsed = {}
  try { parsed = JSON.parse(data.choices?.[0]?.message?.content ?? '{}') } catch {}
  const scores = parsed.scores || []
  const results = jobs.map((_, i) => {
    const s = scores.find((x) => x.i === i || x.index === i)
    return { index: i, score: s ? Math.max(0, Math.min(100, Math.round(s.score))) : 40 }
  })
  return { results, tokensUsed }
}
