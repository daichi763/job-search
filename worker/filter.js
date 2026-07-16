// 機械フィルタ（Cloudflare側 src/lib/filter.ts のNode版）
function overtimeToHours(label) {
  if (!label) return null
  if (label.includes('なし')) return 0
  const m = label.match(/(\d+)\s*時間/)
  return m ? parseInt(m[1], 10) : null
}

// 単一求人を評価。{ job, preScore, hardFail } を返す（ストリーミング用）。
export function evaluateOne(job, c) {
  let hardFail = false
  let score = 0
  let maxScore = 0

  if (c.locations && c.locations.length) {
    maxScore += 30
    const hit = c.locations.some((loc) => (job.locations || []).some((jl) => jl.includes(loc) || loc.includes(jl)))
    if (hit) score += 30
    else hardFail = true
  }
  if (c.salaryMin != null) {
    maxScore += 25
    const jobMax = job.salaryMax ?? job.salaryMin
    if (jobMax != null) {
      if (jobMax >= c.salaryMin) score += (job.salaryMin ?? jobMax) >= c.salaryMin ? 25 : 15
      else hardFail = true
    } else score += 8
  }
  if (c.employment && c.employment.length) {
    maxScore += 15
    if (c.employment.some((e) => (job.employment || '').includes(e))) score += 15
    else hardFail = true
  }
  if (c.jobCategories && c.jobCategories.length) {
    maxScore += 15
    if (c.jobCategories.some((jc) => (job.jobCategory || '').includes(jc) || jc.includes(job.jobCategory || ''))) score += 15
  }
  if (c.industries && c.industries.length) {
    maxScore += 10
    if (c.industries.some((ic) => (job.industry || '').includes(ic) || ic.includes(job.industry || ''))) score += 10
  }
  if (c.overtimeMax) {
    maxScore += 5
    const w = overtimeToHours(c.overtimeMax)
    const j = overtimeToHours(job.overtime)
    if (w != null && j != null) { if (j <= w) score += 5 } else score += 2
  }
  if (c.holiday && c.holiday.length) {
    maxScore += 5
    if (c.holiday.some((h) => (job.holiday || '').includes(h))) score += 5
  }
  const preScore = maxScore > 0 ? Math.round((score / maxScore) * 100) : 50
  return { job, preScore, hardFail }
}

export function mechanicalFilter(jobs, c) {
  const results = []
  for (const job of jobs) {
    let hardFail = false
    let score = 0
    let maxScore = 0

    if (c.locations && c.locations.length) {
      maxScore += 30
      const hit = c.locations.some((loc) => (job.locations || []).some((jl) => jl.includes(loc) || loc.includes(jl)))
      if (hit) score += 30
      else hardFail = true
    }
    if (c.salaryMin != null) {
      maxScore += 25
      const jobMax = job.salaryMax ?? job.salaryMin
      if (jobMax != null) {
        if (jobMax >= c.salaryMin) score += (job.salaryMin ?? jobMax) >= c.salaryMin ? 25 : 15
        else hardFail = true
      } else score += 8
    }
    if (c.employment && c.employment.length) {
      maxScore += 15
      if (c.employment.some((e) => (job.employment || '').includes(e))) score += 15
      else hardFail = true
    }
    if (c.jobCategories && c.jobCategories.length) {
      maxScore += 15
      if (c.jobCategories.some((jc) => (job.jobCategory || '').includes(jc) || jc.includes(job.jobCategory || ''))) score += 15
    }
    if (c.industries && c.industries.length) {
      maxScore += 10
      if (c.industries.some((ic) => (job.industry || '').includes(ic) || ic.includes(job.industry || ''))) score += 10
    }
    if (c.overtimeMax) {
      maxScore += 5
      const w = overtimeToHours(c.overtimeMax)
      const j = overtimeToHours(job.overtime)
      if (w != null && j != null) { if (j <= w) score += 5 } else score += 2
    }
    if (c.holiday && c.holiday.length) {
      maxScore += 5
      if (c.holiday.some((h) => (job.holiday || '').includes(h))) score += 5
    }

    const preScore = maxScore > 0 ? Math.round((score / maxScore) * 100) : 50
    results.push({ job, preScore, hardFail })
  }
  return results.filter((r) => !r.hardFail).sort((a, b) => b.preScore - a.preScore)
}
