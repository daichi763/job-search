// AIスコアリング（Cloudflare側 src/lib/scorer.ts のNode版）

// ------------------------------------------------------------
// モデル選択
//   ・通常モデル(採点など): env.OPENAI_MODEL || 'gpt-5-nano'（安価・高速）
//   ・優秀モデル(条件理解・書類解析): env.OPENAI_MODEL_SMART || 'gpt-5'
//     「抽出結果が送った条件と一致しない」問題への対策として、条件と職務経歴書の
//     内容をより正確に理解する必要がある部分だけ賢いモデルを使う。
//     VPSの worker/.env で OPENAI_MODEL_SMART を上書き可能。
// ------------------------------------------------------------
function baseModel(env) { return env.OPENAI_MODEL || 'gpt-5-nano' }
function smartModel(env) { return env.OPENAI_MODEL_SMART || 'gpt-5' }

// ------------------------------------------------------------
// 文字列サニタイズ
// circus求人説明文に含まれる絵文字/特殊文字が slice() で途中カットされると
// サロゲートペアが分断され、孤立サロゲート(\ud800-\udfff単独)が残る。
// これを JSON.stringify して OpenAI に送ると「failed to parse JSON value」400が発生する。
// 送信前に孤立サロゲートと制御文字を除去して根本回避する。
// ------------------------------------------------------------
// 旧実装は正規表現で孤立サロゲートを除去していたが、連続する孤立下位サロゲート
// (例: \uDE00\uDE00) を取りこぼし、1個残ると OpenAI 400 が再発していた。
// 1文字ずつ厳密に走査し、正規のサロゲートペアだけを残す実装に置き換える。
function sanitizeText(str) {
  if (str == null) return ''
  const s = String(str)
  let out = ''
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i)
    // 制御文字（タブ\t=0x09, 改行\n=0x0A, 復帰\r=0x0D 以外）を空白へ
    if (c <= 0x08 || c === 0x0B || c === 0x0C || (c >= 0x0E && c <= 0x1F) || c === 0x7F) {
      out += ' '
      continue
    }
    // 上位サロゲート: 直後が下位サロゲートなら正規のペアとして両方採用、
    // そうでなければ孤立上位サロゲートとして破棄。
    if (c >= 0xD800 && c <= 0xDBFF) {
      const n = s.charCodeAt(i + 1)
      if (n >= 0xDC00 && n <= 0xDFFF) {
        out += s[i] + s[i + 1]
        i++
      }
      continue
    }
    // 孤立下位サロゲート → 破棄（連続していても各文字で確実に判定）
    if (c >= 0xDC00 && c <= 0xDFFF) continue
    out += s[i]
  }
  return out
}

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
    // 添付書類(職務経歴書/履歴書)の解析結果。個人情報マスク済みの要約。
    // 希望条件と合わせて「この人が目指せる求人」を判断する材料にする。
    c.resumeText ? `\n【添付書類（職務経歴書）の要約】\n${c.resumeText}\n` : '',
    (c.locations || []).length ? `勤務地:${c.locations.join('/')}` : '',
    c.salaryMin ? `年収${c.salaryMin}万以上` : '',
    (c.employment || []).length ? `雇用:${c.employment.join('/')}` : '',
    (c.jobCategories || []).length ? `職種:${c.jobCategories.join('/')}` : '',
    (c.industries || []).length ? `業種:${c.industries.join('/')}` : '',
    // --- 応募条件（HIGH優先の確定データ） ---
    c.age != null && c.age !== '' ? `年齢:${c.age}歳` : '',
    c.gender ? `性別:${c.gender}` : '',
    c.education ? `最終学歴:${c.education}（この学歴以上で応募可能な求人を対象）` : '',
    c.overtimeMax ? `残業:${c.overtimeMax}希望` : '',
    (c.holiday || []).length ? `休日:${c.holiday.join('/')}` : '',
  ].filter(Boolean).join(' / ')
}

// 求人を精読用フル情報テキストに変換。
// ユーザー指定の優先度を明示: 勤務地/年齢/性別/学歴=確度が高い / 職種・未経験タグ=不正確。
//
// 【API直接方式】mapApiJob が返すフラット構造を第一に扱う。
//   確定データ(requiredAge*/requiredGender/requiredEducation/salary*/requirements)は
//   jobSearch レスポンス由来で信頼できるため「[確]」を付ける。
//   職種名(jobCategory)は職種コード由来で概ね正確だが、ユーザ指示に従い過信しない。
// 旧UI方式の job.detail が存在すればそちらを優先（後方互換）。
function jobToFull(job) {
  const d = job.detail
  if (d) return jobToFullFromDetail(job, d)

  // --- API直接方式（フラット構造）---
  const age =
    job.requiredAgeMin != null || job.requiredAgeMax != null
      ? `年齢:${job.requiredAgeMin ?? '?'}〜${job.requiredAgeMax ?? '?'}歳`
      : ''
  const salary =
    job.salaryMin || job.salaryMax
      ? `年収:${job.salaryMin ? Math.round(job.salaryMin / 10000) : '?'}〜${job.salaryMax ? Math.round(job.salaryMax / 10000) : '?'}万`
      : ''
  return [
    job.title ? `タイトル:${String(job.title).slice(0, 80)}` : '',
    job.company ? `企業:${job.company}` : '',
    // --- 確度が高い情報（重視）---
    (job.locations || []).length ? `[確]勤務地:${job.locations.join('/')}` : '',
    age ? `[確]${age}` : '',
    job.requiredGender ? `[確]対象性別:${job.requiredGender}` : '',
    job.requiredEducation ? `[確]必要学歴:${job.requiredEducation}以上` : '',
    salary ? `[確]${salary}` : '',
    job.employment ? `[確]雇用形態:${job.employment}` : '',
    job.requirements ? `[確]必須要件:${String(job.requirements).replace(/\s+/g, ' ').slice(0, 300)}` : '',
    // --- 参考（コード由来だが過信しない）---
    job.jobCategory ? `[参考]職種:${String(job.jobCategory).slice(0, 100)}` : '',
    job.industry ? `[参考]業種:${String(job.industry).slice(0, 100)}` : '',
    (job.positions || []).length ? `[参考]役職:${job.positions.join('/')}` : '',
    job.description ? `仕事内容:${String(job.description).replace(/\s+/g, ' ').slice(0, 700)}` : '',
  ]
    .filter(Boolean)
    .join(' / ')
}

// 旧UI方式(job.detail)向けのフル情報テキスト（後方互換）。
function jobToFullFromDetail(job, d) {
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
    (d.locations || []).length ? `[確]勤務地:${d.locations.join('/')}` : '',
    age ? `[確]${age}` : '',
    d.gender ? `[確]性別:${d.gender}` : '',
    d.education ? `[確]学歴:${d.education}` : '',
    d.nationality ? `[確]国籍:${d.nationality}` : '',
    salary ? `[確]${salary}` : '',
    d.mustRequirements ? `[確]必須要件:${String(d.mustRequirements).replace(/\s+/g, ' ').slice(0, 300)}` : '',
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
複数の求人に対し、それぞれ0〜100点の一致度スコアと、その求人を求職者に薦める理由を返してください。
【理由の書き方】
- 200字程度（180〜220字）で、キャリアアドバイザーが求職者に提案する想定の丁寧な日本語で書く。
- 単なる条件の羅列ではなく「なぜこの人に合うのか」を、要望のフリー記述(価値観・志向・働き方)と結びつけて具体的に説明する。
- 勤務地・年収・仕事内容など求人の魅力ポイントを、要望と対応づけて明示する。
- 懸念点(要望と一部合わない点)があれば正直に一言添えてよい。
【最重要】要望のフリー記述(価値観・キャリア志向・働き方)を最重視する。
【情報の確度による重み付け】
- 「[確]」が付いた項目（勤務地・年齢・性別・学歴・国籍・年収・必須要件）は確度が高い揺るぎない情報。
  これらが要望と明確にミスマッチ（例: 年齢制限外、勤務地が合わない、必須資格を満たさない）なら大きく減点する。
- 「[参考]」が付いた項目（職種名・未経験可タグ）は不正確な場合が多い。参考程度に留め、これだけで大きく増減点しない。
- 情報が不足している項目は中立。
必ず次のJSON形式のみで出力: {"scores":[{"i":0,"score":85,"reason":"200字程度の理由..."},...]}`

export async function scoreBatch(env, criteria, jobs) {
  if (!jobs.length) return { results: [], tokensUsed: 0 }
  const lines = jobs.map((j, i) => `[${i}] ${jobToFull(j)}`).join('\n')
  const user = sanitizeText(`求職者の要望:\n${criteriaToText(criteria)}\n\n求人一覧(${jobs.length}件):\n${lines}\n\n各求人[i]の一致度を採点してJSONで返してください。`)

  const res = await fetch(`${env.OPENAI_BASE_URL}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${env.OPENAI_API_KEY}` },
    body: JSON.stringify({
      model: baseModel(env),
      messages: [{ role: 'system', content: SYSTEM }, { role: 'user', content: user }],
      response_format: { type: 'json_object' },
      reasoning_effort: 'low',
      // 200字程度の理由 × バッチ件数分を賄うため増量
      max_completion_tokens: 6000,
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
    // 理由は200字程度。260字で安全カット。
    return { index: i, score: s ? Math.max(0, Math.min(100, Math.round(s.score))) : 40, reason: s?.reason ? String(s.reason).slice(0, 260) : '' }
  })
  return { results, tokensUsed }
}

// ============================================================
// 条件緩和レコメンド採点
//   通常マッチが払い出し件数(topN)に満たない場合に呼ぶ。
//   年齢/性別/学歴（=変更不可）はクリア済みだが、年収/勤務地/雇用形態などの
//   「緩和可能条件」で外れた求人を対象に、
//     ・それでも求職者に薦められるか(0〜100)
//     ・どの条件をどう妥協すれば良いか＋薦める理由(300字程度)
//   を返す。理由は「求職者様に提出する」丁寧な文面。
// ============================================================
const SYSTEM_RELAX = `あなたは人材紹介のプロのキャリアアドバイザーです。
求職者の希望条件では該当求人が不足しているため、「変更可能な条件を少し緩和すれば提案できる求人」を評価します。
各求人には「緩和が必要な条件(relaxed)」が付いています。年齢・性別・学歴は既にクリアしているので触れません。
【厳守】
- 年齢・性別・学歴は変更不可。これらを緩める提案は絶対にしない。
- 緩和してよいのは年収・勤務地・職種・業種・雇用形態・残業・休日など。
【各求人について返すもの】
- score: この求人を(条件緩和込みで)求職者に薦められる度合い 0〜100。
- reason: 求職者様に提出する想定の丁寧な日本語で300字程度(280〜320字)。
  ・どの条件をどの程度妥協することになるかを最初に明示する(例:「ご希望年収より少し下がりますが」「勤務地は隣県になりますが」)。
  ・その上で、なぜそれでも十分魅力的か(仕事内容・成長性・待遇・要望との合致点)を具体的に説明し、前向きに背中を押す文面にする。
  ・要望のフリー記述(価値観・志向)と結びつける。
必ず次のJSON形式のみ: {"scores":[{"i":0,"score":78,"reason":"300字程度の提案理由..."},...]}`

export async function scoreRelaxBatch(env, criteria, entries) {
  // entries: [{ job, relaxedReasons: [...] }]
  if (!entries.length) return { results: [], tokensUsed: 0 }
  const lines = entries.map((e, i) => {
    const relaxed = (e.relaxedReasons || []).length ? ` / [要緩和]${e.relaxedReasons.join('、')}` : ''
    return `[${i}] ${jobToFull(e.job)}${relaxed}`
  }).join('\n')
  const user = sanitizeText(`求職者の要望:\n${criteriaToText(criteria)}\n\n【条件を緩めれば提案できる求人】(${entries.length}件):\n${lines}\n\n各求人[i]について、緩和込みで薦められるかを採点し、求職者様への提案理由(300字程度)を書いてJSONで返してください。`)

  const res = await fetch(`${env.OPENAI_BASE_URL}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${env.OPENAI_API_KEY}` },
    body: JSON.stringify({
      model: baseModel(env),
      messages: [{ role: 'system', content: SYSTEM_RELAX }, { role: 'user', content: user }],
      response_format: { type: 'json_object' },
      reasoning_effort: 'low',
      max_completion_tokens: 7000,
    }),
  })
  if (!res.ok) throw new Error(`OpenAI(relax) ${res.status}: ${(await res.text()).slice(0, 200)}`)
  const data = await res.json()
  const tokensUsed = data.usage?.total_tokens ?? 0
  let parsed = {}
  try { parsed = JSON.parse(data.choices?.[0]?.message?.content ?? '{}') } catch {}
  const scores = parsed.scores || []
  const results = entries.map((_, i) => {
    const s = scores.find((x) => x.i === i || x.index === i)
    return {
      index: i,
      score: s ? Math.max(0, Math.min(100, Math.round(s.score))) : 0,
      reason: s?.reason ? String(s.reason).slice(0, 400) : '',
    }
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
  const user = sanitizeText(`求職者の要望:\n${criteriaToText(criteria)}\n\n求人一覧(${jobs.length}件):\n${lines}\n\n各求人[i]をざっくり採点しJSONで返してください。`)

  const res = await fetch(`${env.OPENAI_BASE_URL}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${env.OPENAI_API_KEY}` },
    body: JSON.stringify({
      model: baseModel(env),
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

// ============================================================
// 【機能A（AI条件反復検索）】 buildSearchPlans
// 長文の求人要望から、circus API を叩くための「検索プラン」を複数生成する。
// 各プランは qJson用キーワード群 + フィルタコード(occupations/industries/
// prefectures/education/gender/age/salary/overtime)を持つ。
// ユーザのFunction Aパターン=「少しずつ条件を変えて複数回検索し求人を出す」を
// AIに実行させるため、切り口の異なる複数プランを一度に作らせる。
//
// ユーザ指示の遵守点:
//  - 勤務地は県レベルで十分（過剰に絞らない）
//  - 業種・職種は絞りすぎ禁物（内容膨大。広めのカテゴリを少数だけ）
//  - HIGH優先=勤務地/年齢/性別/学歴（確度が高い）を条件に使う
//  - LOW優先=職種・業種・未経験タグ（不正確なので絞りすぎない／AI採点で補正）
// ============================================================

import {
  resolveOccupations, resolveIndustries, resolvePrefectures,
  resolveEducation, resolveGender, resolveOvertime, EDU_ORDER, EDUCATION,
  occupationCatalogText, industryCatalogText, prefectureCatalogText,
} from './circus_master.js'

// 学歴応募可能ロジック:
// 求職者の最終学歴(applicantEduLabel)で応募できる求人 = 「要求学歴 ≦ 求職者学歴」。
// circus の education パラメータは「その学歴（以上）で応募可能」を意味するので、
// 求職者が大卒なら education は {学歴不問, 高卒, 専門卒, 短大卒, 大卒} が応募可。
// ただしAPIの education= は単一値で「その学歴の求人」に絞る用途。
// 実務上は「求職者学歴で応募可能な求人すべて」を出したいので、
// education フィルタは指定せず（=全学歴）、AI採点/機械フィルタ側で
// 「要求学歴 ≦ 求職者学歴」を判定する方針とする。
// → よって buildSearchPlans では education を強い絞り込みには使わない。

const PLAN_SYSTEM = `あなたは人材紹介のプロの検索ストラテジストです。
求職者の要望（長文・曖昧なこともある）を読み解き、求人データベースを横断検索するための「検索プラン」を複数作ります。
1つのプランだけでは見つけづらい求人を取りこぼすため、切り口の異なる複数プラン(3〜5個)を作ってください。

【厳守事項】
- 勤務地(prefectures)は県レベルで指定。要望に地域があれば県名を、なければ空配列。過剰に絞らない。
- 職種(occupations)・業種(industries)は「絞りすぎ厳禁」。各プランで広めのカテゴリを0〜3個だけ。要望から明確に読み取れる場合のみ指定し、曖昧なら空配列にしてキーワード検索に委ねる。
- キーワード(keywords)は検索の主軸。要望から重要な語(職種名・スキル・志向)を2〜5語。長文をそのまま入れない（ヒット0になる）。
- 各プランは「少しずつ条件を変える」= プランAは広め、プランBは職種で絞る、プランCは別の業種切り口…のように多様化する。
- age/gender は求職者の属性が要望にあれば数値/文字で指定（なければ省略）。
- salaryMin は要望の希望年収(万円)があれば指定（なければ省略）。
- 【添付書類（職務経歴書）の要約】がある場合は、その経験職種・スキル・業界・到達役職を最大限に活かす。
  希望条件だけでなく「この経歴なら目指せる求人」を捉えるプランも1つ以上含める（例: 経験職種の隣接領域やキャリアアップ先）。
  ただし求職者が明示した希望条件（勤務地・年齢・性別・学歴など）は尊重し、書類情報で上書きしない。

【指定可能な値】
- occupations/industries: 下記カタログの「コード:ラベル」から選ぶ。ラベル文字列で指定してよい（システムがコードに変換）。
- prefectures: 都道府県名（例:「東京都」「大阪府」）。
- gender: 「男性」または「女性」。
- education: 「高卒」「専門卒」「短大卒」「大卒」「大学院卒」「学歴不問」のいずれか（求職者の最終学歴）。

必ず次のJSON形式のみで出力:
{"plans":[{"label":"プランの狙い(20字)","keywords":["語1","語2"],"occupations":["ラベル"],"industries":["ラベル"],"prefectures":["東京都"],"gender":"","education":"","age":null,"salaryMin":null}]}`

// AIにカタログ全文を渡すとトークンが嵩む。tab見出し＋代表ラベルの
// 要約カタログを渡し、ラベル文字列で指定させてこちら側でコード解決する。
export async function buildSearchPlans(env, criteria) {
  const occCat = occupationCatalogText()
  const indCat = industryCatalogText()

  const userMsg = [
    `求職者の要望:\n${criteriaToText(criteria)}`,
    criteria.age != null && criteria.age !== '' ? `\n求職者の年齢: ${criteria.age}歳` : '',
    criteria.gender ? `求職者の性別: ${criteria.gender}` : '',
    criteria.education ? `求職者の最終学歴: ${criteria.education}` : '',
    `\n\n【職種カタログ(コード:ラベル)】\n${occCat}`,
    `\n\n【業種カタログ(コード:ラベル)】\n${indCat}`,
    `\n\n上記を踏まえ、切り口の異なる検索プランを3〜5個JSONで返してください。`,
  ].filter(Boolean).join('\n')
  const userMsgClean = sanitizeText(userMsg)

  const res = await fetch(`${env.OPENAI_BASE_URL}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${env.OPENAI_API_KEY}` },
    body: JSON.stringify({
      // 条件理解の精度が検索結果の一致率を左右するため、優秀モデルを使用
      model: smartModel(env),
      messages: [{ role: 'system', content: PLAN_SYSTEM }, { role: 'user', content: userMsgClean }],
      response_format: { type: 'json_object' },
      reasoning_effort: 'medium',
      max_completion_tokens: 4000,
    }),
  })
  if (!res.ok) throw new Error(`OpenAI(plans) ${res.status}: ${(await res.text()).slice(0, 200)}`)
  const data = await res.json()
  const tokensUsed = data.usage?.total_tokens ?? 0
  let parsed = {}
  try { parsed = JSON.parse(data.choices?.[0]?.message?.content ?? '{}') } catch {}
  const rawPlans = Array.isArray(parsed.plans) ? parsed.plans : []

  // AIが返したラベル/文字列を circus API のコード＋qJson へ解決する。
  const plans = rawPlans.map((p, idx) => resolvePlan(p, criteria, idx)).filter(Boolean)

  // 何も返らなかった場合の保険: criteria から最低1プラン組み立て
  if (plans.length === 0) {
    plans.push(resolvePlan({
      label: 'フォールバック(要望キーワード)',
      keywords: [],
      occupations: criteria.jobCategories || [],
      industries: criteria.industries || [],
      prefectures: criteria.locations || [],
      gender: criteria.gender || '',
      education: criteria.education || '',
      age: criteria.age ?? null,
      salaryMin: criteria.salaryMin ?? null,
    }, criteria, 0))
  }

  return { plans, tokensUsed }
}

// 1プラン(ラベル/文字列ベース) → 実行可能プラン(qJson + filters コード)へ解決。
function resolvePlan(p, criteria, idx) {
  if (!p) return null
  const keywords = (Array.isArray(p.keywords) ? p.keywords : []).map((s) => String(s).trim()).filter(Boolean)
  // occupations/industries はラベル or コード → コードへ
  const occupations = [...new Set(resolveOccupations(p.occupations || []))]
  const industries = [...new Set(resolveIndustries(p.industries || []))]
  // 勤務地: プラン優先、無ければ criteria.locations
  const prefInput = (p.prefectures && p.prefectures.length) ? p.prefectures : (criteria.locations || [])
  const prefectures = [...new Set(resolvePrefectures(prefInput))]

  // 性別: プラン優先、無ければ criteria.gender
  const genderCode = firstOr(resolveGender(p.gender || criteria.gender || ''))
  // 残業: criteria.overtimeMax から
  const overtimeCode = firstOr(resolveOvertime(criteria.overtimeMax || ''))

  // 年齢: プラン優先、無ければ criteria.age
  const ageVal = numOrNull(p.age != null ? p.age : criteria.age)
  // 年収(万): プラン優先、無ければ criteria.salaryMin
  const salaryMin = numOrNull(p.salaryMin != null ? p.salaryMin : criteria.salaryMin)

  // qJson: キーワードは OR ロジックにスペース連結で入れる（複数語を or 検索）
  const orKeyword = keywords.join(' ')

  const filters = {}
  if (occupations.length) filters.occupations = occupations
  if (industries.length) filters.industries = industries
  if (prefectures.length) filters.prefectures = prefectures
  if (genderCode) filters.requiredGenders = genderCode
  if (overtimeCode) filters.averageOvertimes = overtimeCode
  if (ageVal != null) filters.age = ageVal
  if (salaryMin != null) filters.annualSalaryInclude = salaryMin
  // ※ education は絞り込みに使わない（上記コメント参照。採点/機械フィルタで判定）

  return {
    label: String(p.label || `プラン${idx + 1}`).slice(0, 40),
    keywords,
    orKeyword,
    filters,
    // 人間可読サマリ（ログ用）
    summary: {
      keywords, occupations, industries, prefectures,
      gender: p.gender || criteria.gender || null,
      age: ageVal, salaryMin,
    },
  }
}

function firstOr(arr) { return (Array.isArray(arr) && arr.length) ? arr[0] : null }
function numOrNull(v) {
  if (v == null || v === '') return null
  const n = typeof v === 'number' ? v : parseInt(String(v).replace(/[^\d]/g, ''), 10)
  return Number.isFinite(n) ? n : null
}
