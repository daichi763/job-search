// 機械フィルタ（Cloudflare側 src/lib/filter.ts のNode版）
function overtimeToHours(label) {
  if (!label) return null
  if (label.includes('なし')) return 0
  const m = label.match(/(\d+)\s*時間/)
  return m ? parseInt(m[1], 10) : null
}

// 単一求人を評価。{ job, preScore, hardFail } を返す（ストリーミング用）。
//
// ※この評価は「探索時＝詳細ページ取得前」に走るため、カード情報しか使えない。
//   年齢/性別/学歴（＝揺るぎないHIGH情報）は詳細ページにしか無いので、ここでは判定せず
//   詳細取得後の evaluateDetail() で hardFail 判定する。
// ※職種/業種は「不正確な場合が多い」(ユーザー指定LOW)ため、hardFail にはせず重みも小さく。
export function evaluateOne(job, c) {
  let hardFail = false
  let score = 0
  let maxScore = 0
  const reasons = [] // hardFail要因（緩和レコメンド用: どの緩和可能条件で落ちたか）

  // --- HIGH: 勤務地（カードにあり／揺るぎない）---
  if (c.locations && c.locations.length) {
    maxScore += 35
    const hit = c.locations.some((loc) => (job.locations || []).some((jl) => jl.includes(loc) || loc.includes(jl)))
    if (hit) score += 35
    else { hardFail = true; reasons.push(`勤務地(希望:${c.locations.join('/')})が不一致`) }
  }
  // --- HIGH: 年収（カードにあり）---
  if (c.salaryMin != null) {
    maxScore += 30
    const jobMax = job.salaryMax ?? job.salaryMin
    if (jobMax != null) {
      if (jobMax >= c.salaryMin) score += (job.salaryMin ?? jobMax) >= c.salaryMin ? 30 : 18
      else { hardFail = true; reasons.push(`想定年収が希望(${c.salaryMin}万〜)に届かない`) }
    } else score += 10
  }
  // --- 雇用形態（カードにあり）---
  if (c.employment && c.employment.length) {
    maxScore += 15
    if (c.employment.some((e) => (job.employment || '').includes(e))) score += 15
    else { hardFail = true; reasons.push(`雇用形態(希望:${c.employment.join('/')})が不一致`) }
  }
  // --- LOW: 職種（不正確な場合が多い。hardFailにせず軽い加点のみ）---
  if (c.jobCategories && c.jobCategories.length) {
    maxScore += 8
    if (c.jobCategories.some((jc) => (job.jobCategory || '').includes(jc) || jc.includes(job.jobCategory || ''))) score += 8
  }
  // --- LOW: 業種（不正確な場合が多い。hardFailにせず軽い加点のみ）---
  if (c.industries && c.industries.length) {
    maxScore += 5
    if (c.industries.some((ic) => (job.industry || '').includes(ic) || ic.includes(job.industry || ''))) score += 5
  }
  if (c.overtimeMax) {
    maxScore += 4
    const w = overtimeToHours(c.overtimeMax)
    const j = overtimeToHours(job.overtime)
    if (w != null && j != null) { if (j <= w) score += 4 } else score += 2
  }
  if (c.holiday && c.holiday.length) {
    maxScore += 3
    if (c.holiday.some((h) => (job.holiday || '').includes(h))) score += 3
  }
  const preScore = maxScore > 0 ? Math.round((score / maxScore) * 100) : 50
  return { job, preScore, hardFail, reasons }
}

// 学歴のランク（数値が大きいほど高い学歴要件）。求職者の学歴が求人の要件を満たすか判定用。
const EDU_RANK = {
  学歴不問: 0, 中卒以上: 1, 高卒以上: 2, 専門卒以上: 3, 短大卒以上: 3, 高専卒以上: 3, 大卒以上: 4, 大学院卒: 5,
}
const EDU_APPLICANT = {
  中卒: 1, 高卒: 2, 専門卒: 3, 短大卒: 3, 高専卒: 3, 大卒: 4, 大学卒: 4, 大学院卒: 5, 院卒: 5,
}

// 「揺るぎないHIGH情報」（年齢/性別/学歴）による判定。
// criteria(求職者の age/gender/education) と求人の応募条件を突き合わせ、
// 明確なミスマッチなら hardFail=true を返す。情報が無い項目は中立(判定しない)。
//
// 【API直接方式】mapApiJob が返すフラット構造を第一に扱う:
//   requiredAgeMin / requiredAgeMax / requiredGender / requiredEducation
// 旧UI方式(job.detail: ageMin/ageMax/gender/education)も後方互換で受ける。
// circus の requiredEducation は「その学歴（以上）で応募可能」＝求人が要求する最低学歴。
//   EDUCATION: 学歴不問 / 高卒 / 専門卒 / 短大卒 / 大卒 / 大学院卒
// 戻り値: { hardFail, reasons: [不一致理由...] }
export function evaluateDetail(job, c) {
  const d = job.detail
  // フラット(API) / ネスト(detail) 両対応でHIGH情報を取り出す
  const ageMin = d ? d.ageMin : job.requiredAgeMin
  const ageMax = d ? d.ageMax : job.requiredAgeMax
  const gender = d ? d.gender : job.requiredGender
  const education = d ? d.education : job.requiredEducation
  // 判定材料が一つも無ければ中立
  if (ageMin == null && ageMax == null && !gender && !education) {
    return { hardFail: false, reasons: [] }
  }
  const reasons = []
  let hardFail = false

  // 年齢: 求職者の年齢が求人の年齢制限レンジ外なら不適合
  if (c.age != null && c.age !== '') {
    const age = typeof c.age === 'number' ? c.age : parseInt(String(c.age), 10)
    if (Number.isFinite(age)) {
      if (ageMin != null && age < ageMin) { hardFail = true; reasons.push(`年齢下限(${ageMin}歳〜)未満`) }
      if (ageMax != null && age > ageMax) { hardFail = true; reasons.push(`年齢上限(〜${ageMax}歳)超過`) }
    }
  }

  // 性別: 求人が特定性別のみ募集で、求職者と異なるなら不適合（不問=nullはOK）
  if (c.gender && gender && gender !== '不問') {
    if (gender !== c.gender) { hardFail = true; reasons.push(`性別要件(${gender}のみ)不一致`) }
  }

  // 学歴: 求職者の学歴が求人の要求学歴に満たなければ不適合（学歴不問はOK）
  //   requiredEducation は求人が要求する最低学歴（高卒/専門卒/…）。
  //   求職者の学歴ランク ≧ 要求学歴ランク なら応募可。
  if (c.education && education && education !== '学歴不問') {
    const need = EDU_MIN_RANK[education]      // 求人が要求する最低学歴のランク
    const have = EDU_APPLICANT[c.education]   // 求職者の学歴ランク
    if (need != null && have != null && have < need) {
      hardFail = true
      reasons.push(`学歴要件(${education}以上)未達`)
    }
  }

  return { hardFail, reasons }
}

// API方式の requiredEducation（求人が要求する最低学歴）→ ランク。
// 求職者(EDU_APPLICANT)と同一尺度で比較する。
const EDU_MIN_RANK = {
  学歴不問: 0, 中卒: 1, 高卒: 2, 専門卒: 3, 短大卒: 3, 高専卒: 3, 大卒: 4, 大学院卒: 5,
  // 旧UI表記も念のため
  中卒以上: 1, 高卒以上: 2, 専門卒以上: 3, 短大卒以上: 3, 高専卒以上: 3, 大卒以上: 4,
}

export function mechanicalFilter(jobs, c) {
  const results = jobs.map((job) => evaluateOne(job, c))
  return results.filter((r) => !r.hardFail).sort((a, b) => b.preScore - a.preScore)
}
