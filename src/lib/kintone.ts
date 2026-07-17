// kintone(④ 自社DB) コネクタ
// 公式REST APIで求人を取得し、NormalizedJob へ正規化する。

import type { NormalizedJob } from './types'

export interface KintoneConfig {
  subdomain: string
  appId: string
  apiToken: string
}

// フィールドコード → 値 を安全に取り出す
function fv(record: any, code: string): string {
  const f = record[code]
  if (!f) return ''
  const v = f.value
  if (v == null) return ''
  if (Array.isArray(v)) {
    // MULTI_SELECT / CHECK_BOX
    return v.join(', ')
  }
  return String(v)
}

function fvArray(record: any, code: string): string[] {
  const f = record[code]
  if (!f || f.value == null) return []
  if (Array.isArray(f.value)) return f.value.map((x: any) => String(x))
  return [String(f.value)]
}

function toNum(s: string): number | null {
  if (!s) return null
  const n = parseInt(String(s).replace(/[^0-9]/g, ''), 10)
  return Number.isFinite(n) ? n : null
}

export function normalizeKintoneRecord(record: any, subdomain: string, appId: string): NormalizedJob {
  const sourceJobId =
    fv(record, '求人ID') || fv(record, 'レコード番号') || fv(record, '$id') || ''
  const recordNo = fv(record, 'レコード番号') || fv(record, '$id')

  // 求人公開チェックボックスに「可能」が入っていれば公開中
  const publicVals = fvArray(record, '求人公開')
  const isOpen = publicVals.includes('可能') || publicVals.length > 0

  return {
    source: 'kintone',
    sourceJobId,
    title: fv(record, '求人タイトル'),
    company: fv(record, '企業名'),
    jobCategory:
      fv(record, 'メイン職種_大分類_') || fv(record, 'メイン職種') || '',
    industry:
      fv(record, 'メイン業種_大分類_') || fv(record, 'メイン業種') || '',
    employment: fv(record, '雇用形態'),
    locations: fvArray(record, '勤務地'),
    salaryMin: toNum(fv(record, '想定年収_下限_')),
    salaryMax: toNum(fv(record, '想定年収_上限_')),
    overtime: fv(record, '月間平均残業時間'),
    holiday: fv(record, '休日'),
    benefits: fv(record, '福利厚生・諸手当'),
    requirements: fv(record, '応募必須条件'),
    description: [
      fv(record, '仕事内容'),
      fv(record, 'PRポイント'),
      fv(record, '内定の可能性が高い人'),
    ]
      .filter(Boolean)
      .join('\n\n')
      .slice(0, 2000),
    url: recordNo
      ? `https://${subdomain}.cybozu.com/k/${appId}/show#record=${recordNo}`
      : '',
    isOpen,
    raw: undefined,
  }
}

// 総件数を取得（軽量: $id のみ）
export async function fetchKintoneCount(cfg: KintoneConfig): Promise<number> {
  assertKintoneConfig(cfg)
  const url = `https://${cfg.subdomain}.cybozu.com/k/v1/records.json`
  let total = 0
  let lastId = 0
  // カーソルなしのシンプルなページング（$id > lastId）
  for (let i = 0; i < 50; i++) {
    const query = `$id > ${lastId} order by $id asc limit 500`
    const res = await fetch(
      `${url}?app=${cfg.appId}&fields[0]=$id&query=${encodeURIComponent(query)}`,
      { headers: { 'X-Cybozu-API-Token': cfg.apiToken } }
    )
    if (!res.ok) break
    const data: any = await res.json()
    const recs = data.records || []
    total += recs.length
    if (recs.length < 500) break
    lastId = Math.max(...recs.map((r: any) => parseInt(r.$id.value, 10)))
  }
  return total
}

// 設定が揃っているか検証（未設定だと https://undefined.cybozu.com/... のような
// 壊れたURLになり、cybozu以外のホストから汎用404 HTMLが返る＝原因が分かりにくい）。
function assertKintoneConfig(cfg: KintoneConfig) {
  const missing: string[] = []
  if (!cfg.subdomain || cfg.subdomain === 'undefined') missing.push('KINTONE_SUBDOMAIN')
  if (!cfg.appId || cfg.appId === 'undefined') missing.push('KINTONE_APP_ID')
  if (!cfg.apiToken || cfg.apiToken === 'undefined') missing.push('KINTONE_API_TOKEN')
  if (missing.length) {
    throw new Error(
      `kintone設定が未設定です: ${missing.join(', ')}。` +
      `Cloudflare/wrangler側の環境変数(.dev.vars または wrangler secret)を確認してください。`
    )
  }
}

// 全求人を取得（ページング、$idカーソル方式で500件超も対応）
export async function fetchKintoneJobs(
  cfg: KintoneConfig,
  opts: { onlyOpen?: boolean; max?: number } = {}
): Promise<NormalizedJob[]> {
  assertKintoneConfig(cfg)
  const url = `https://${cfg.subdomain}.cybozu.com/k/v1/records.json`
  const jobs: NormalizedJob[] = []
  let lastId = 0
  const max = opts.max ?? 5000

  for (let i = 0; i < 50 && jobs.length < max; i++) {
    const query = `$id > ${lastId} order by $id asc limit 500`
    const res = await fetch(
      `${url}?app=${cfg.appId}&query=${encodeURIComponent(query)}`,
      { headers: { 'X-Cybozu-API-Token': cfg.apiToken } }
    )
    if (!res.ok) {
      const t = await res.text()
      // 404かつHTMLが返る場合は「サブドメイン/APPID誤り or 未設定」の可能性が高い
      const hint = res.status === 404
        ? `（サブドメイン"${cfg.subdomain}"・アプリID"${cfg.appId}"・APIトークンが正しいか確認してください）`
        : ''
      throw new Error(`kintone API error ${res.status}${hint}: ${t.slice(0, 150)}`)
    }
    const data: any = await res.json()
    const recs = data.records || []
    for (const r of recs) {
      const job = normalizeKintoneRecord(r, cfg.subdomain, cfg.appId)
      if (opts.onlyOpen && !job.isOpen) continue
      jobs.push(job)
    }
    if (recs.length < 500) break
    lastId = Math.max(...recs.map((r: any) => parseInt(r.$id.value, 10)))
  }
  return jobs
}
