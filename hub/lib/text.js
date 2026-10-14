// ============================================================
// 全文検索用のテキスト処理（2文字単位の索引 = bigram）
//
//   SQLite標準の trigram(3文字単位) では「営業」「経理」など2文字語が検索できない。
//   そこで文字列を2文字ずつ区切ったトークン列を自前で作り、FTS5 に入れる。
//     「法人営業」→ "法人 人営 営業"
//   検索語も同じように区切り、連続一致(フレーズ検索)させることで
//   「部分一致(LIKE '%語%')」と同じ結果を索引で高速に得る。
// ============================================================

// 表記ゆれの吸収: 全角英数→半角、大文字→小文字、半角カナ→全角 (NFKC)
export function normalizeText(s) {
  if (s == null) return ''
  return String(s).normalize('NFKC').toLowerCase()
}

// 文字・数字の連続（＝区切り文字で分けた塊）を取り出す
const RUN_RE = /[\p{L}\p{N}\p{M}ー]+/gu

// 文字列 → 2文字単位トークン列（空白区切り）
//   塊と塊の間には区切り用の目印(3文字=2文字トークンと衝突しない)を入れ、
//   「営業／事務」の「業」と「事」がつながって「業事」と誤ってヒットしないようにする。
export const SEP_TOKEN = 'qqq'
export function toBigrams(s, maxLen = 4000) {
  const t = normalizeText(s).slice(0, maxLen)
  const out = []
  for (const m of t.matchAll(RUN_RE)) {
    const run = Array.from(m[0]) // サロゲートペア安全
    if (out.length) out.push(SEP_TOKEN)
    if (run.length === 1) { out.push(run[0]); continue }
    for (let i = 0; i < run.length - 1; i++) out.push(run[i] + run[i + 1])
  }
  return out.join(' ')
}

// 検索語 → FTS5 の MATCH 式。
//   ・空白区切りの複数語は AND
//   ・各語は2文字トークンの連続一致（フレーズ）
//   ・1文字だけの語は索引で正確に引けないため null を返し、呼び出し側で LIKE にする
export function toMatchQuery(keyword) {
  const words = normalizeText(keyword).split(/[\s　]+/).filter(Boolean)
  const parts = []
  const single = []
  for (const w of words) {
    const grams = []
    for (const m of w.matchAll(RUN_RE)) {
      const run = Array.from(m[0])
      if (run.length === 1) { single.push(run[0]); continue }
      for (let i = 0; i < run.length - 1; i++) grams.push(run[i] + run[i + 1])
    }
    if (grams.length) parts.push(`"${grams.join(' ')}"`)
  }
  return { match: parts.length ? parts.join(' AND ') : null, singleChars: single }
}
