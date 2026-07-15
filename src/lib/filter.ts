// 1段階目: コード側の機械フィルタ（トークン消費ゼロ）
// 選択条件で候補を絞り、AIに投げる件数を最小化する。
// さらに「事前スコア」を計算し、AIに投げる優先順位付けに使う。

import type { NormalizedJob, SearchCriteria } from './types'

// 残業時間ラベルを数値(時間)に変換（上限のおおよそ）
function overtimeToHours(label: string): number | null {
  if (!label) return null
  if (label.includes('なし')) return 0
  const m = label.match(/(\d+)\s*時間/)
  if (m) return parseInt(m[1], 10)
  return null
}

export interface FilterResult {
  job: NormalizedJob
  preScore: number // 機械的な事前一致度(0-100) … AI採点の優先順位付け用
  hardFail: boolean // 必須条件を満たさない(除外対象)
}

// 機械フィルタ + 事前スコア計算
export function mechanicalFilter(
  jobs: NormalizedJob[],
  c: SearchCriteria
): FilterResult[] {
  const results: FilterResult[] = []

  for (const job of jobs) {
    let hardFail = false
    let score = 0
    let maxScore = 0

    // --- 勤務地 (重み30) ---
    if (c.locations.length > 0) {
      maxScore += 30
      const hit = c.locations.some((loc) =>
        job.locations.some((jl) => jl.includes(loc) || loc.includes(jl))
      )
      if (hit) score += 30
      else hardFail = true // 勤務地は必須条件扱い
    }

    // --- 年収 (重み25) ---
    if (c.salaryMin != null) {
      maxScore += 25
      // 求人の上限が希望下限に届いているか
      const jobMax = job.salaryMax ?? job.salaryMin
      if (jobMax != null) {
        if (jobMax >= c.salaryMin) {
          // 求人下限が希望を上回るほど高評価
          const jm = job.salaryMin ?? jobMax
          if (jm >= c.salaryMin) score += 25
          else score += 15 // 範囲的にはギリ届く
        } else {
          hardFail = true // 年収が全く届かない
        }
      } else {
        score += 8 // 年収情報なし → 中立寄り
      }
    }
    if (c.salaryMax != null) {
      // 希望年収上限は「これ以下がベター」ではなくフィルタしない（高い分には問題ない）
    }

    // --- 雇用形態 (重み15) ---
    if (c.employment.length > 0) {
      maxScore += 15
      const hit = c.employment.some((e) => job.employment.includes(e))
      if (hit) score += 15
      else hardFail = true
    }

    // --- 職種大分類 (重み15) ---
    if (c.jobCategories.length > 0) {
      maxScore += 15
      const hit = c.jobCategories.some(
        (jc) => job.jobCategory.includes(jc) || jc.includes(job.jobCategory)
      )
      if (hit) score += 15
      // 職種はhardFailにしない（近い職種も拾いたい）→ AIに判断させる
    }

    // --- 業種大分類 (重み10) ---
    if (c.industries.length > 0) {
      maxScore += 10
      const hit = c.industries.some(
        (ic) => job.industry.includes(ic) || ic.includes(job.industry)
      )
      if (hit) score += 10
    }

    // --- 残業 (重み5) ---
    if (c.overtimeMax) {
      maxScore += 5
      const wantH = overtimeToHours(c.overtimeMax)
      const jobH = overtimeToHours(job.overtime)
      if (wantH != null && jobH != null) {
        if (jobH <= wantH) score += 5
      } else {
        score += 2
      }
    }

    // --- 休日 (重み5) ---
    if (c.holiday.length > 0) {
      maxScore += 5
      const hit = c.holiday.some((h) => job.holiday.includes(h))
      if (hit) score += 5
    }

    // --- 福利厚生 (加点のみ、重み5) ---
    if (c.benefits.length > 0) {
      maxScore += 5
      const hitCount = c.benefits.filter((b) => job.benefits.includes(b)).length
      if (c.benefits.length > 0) {
        score += Math.round((hitCount / c.benefits.length) * 5)
      }
    }

    const preScore = maxScore > 0 ? Math.round((score / maxScore) * 100) : 50

    results.push({ job, preScore, hardFail })
  }

  // hardFailを除外し、preScore降順（AIに優先的に投げる順）
  return results
    .filter((r) => !r.hardFail)
    .sort((a, b) => b.preScore - a.preScore)
}
