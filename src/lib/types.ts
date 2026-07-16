// 共通型定義

export type SourceId = 'kintone' | 'circus' | 'hitolink' | 'jobins'

export const SOURCE_LABELS: Record<SourceId, string> = {
  kintone: '自社DB (kintone)',
  circus: 'circusAGENT',
  hitolink: 'ヒトリンク',
  jobins: 'ジョビンズ',
}

// 正規化された求人データ
export interface NormalizedJob {
  source: SourceId
  sourceJobId: string
  title: string
  company: string
  jobCategory: string
  industry: string
  employment: string
  locations: string[]
  salaryMin: number | null // 万円
  salaryMax: number | null // 万円
  overtime: string
  holiday: string
  benefits: string
  requirements: string
  description: string
  url: string
  isOpen: boolean
  raw?: any
}

// 検索条件
export interface SearchCriteria {
  freeText: string // フリー記述の要望
  locations: string[] // 希望勤務地(都道府県)
  salaryMin: number | null // 希望年収下限(万円)
  salaryMax: number | null // 希望年収上限(万円)
  employment: string[] // 雇用形態
  jobCategories: string[] // 職種(大分類)
  industries: string[] // 業種(大分類)
  overtimeMax: string // 残業許容
  holiday: string[] // 休日
  benefits: string[] // 福利厚生
  requirements: string // その他必須条件(テキスト)
  // --- 応募条件（HIGH優先の確定データ。circus API で直接フィルタ／HIGH判定に使用）---
  age: number | null // 求職者の年齢
  gender: string // 求職者の性別（'男性'|'女性'|''）
  education: string // 求職者の最終学歴（'高卒'|'専門卒'|'短大卒'|'大卒'|'大学院卒'|'学歴不問'|''）
  topN: number // 払い出す件数
  sources: SourceId[] // 検索対象DB
}

// AI採点結果
export interface ScoreResult {
  score: number // 0-100
  reason: string
}
