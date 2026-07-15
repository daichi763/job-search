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
  topN: number // 払い出す件数
  sources: SourceId[] // 検索対象DB
}

// AI採点結果
export interface ScoreResult {
  score: number // 0-100
  reason: string
}
