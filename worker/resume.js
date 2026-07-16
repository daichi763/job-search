// ------------------------------------------------------------
// 職務経歴書 / 履歴書（PDF）解析モジュール
//
// フロー:
//   1) base64 PDF → Buffer → pdf-parse でテキスト抽出（PDFのみ対応）
//   2) 氏名・住所などの個人情報(PII)をマスク（OpenAIへ送る前に除去）
//   3) 優秀モデル(smartModel)で「求人マッチングに使える要約」を抽出
//   4) 呼び出し側は解析後に元PDF(base64)を破棄する（このモジュールは保持しない）
//
// 方針(ユーザー確定):
//   ・対応形式: PDFのみ
//   ・個人情報: 氏名・住所などのPIIのみマスクした上でOpenAIへ送ってよい
//   ・保存: 完了後に破棄（永続化しない）
// ------------------------------------------------------------

// pdf-parse本体を直接import（パッケージのindex.jsはデバッグ用にテストPDFを読むため回避）
import pdfParse from 'pdf-parse/lib/pdf-parse.js'

// 優秀モデル(条件・書類理解用)。scorer.js と同じ既定値。
function smartModel(env) { return env.OPENAI_MODEL_SMART || 'gpt-5' }

// ------------------------------------------------------------
// 文字列サニタイズ（孤立サロゲート/制御文字除去。scorer.jsと同等）
// ------------------------------------------------------------
function sanitizeText(str) {
  if (str == null) return ''
  return String(str)
    .replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/g, '')
    .replace(/(^|[^\uD800-\uDBFF])[\uDC00-\uDFFF]/g, '$1')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, ' ')
}

// ------------------------------------------------------------
// PII(個人情報)マスク
//   OpenAIへ送る前に、氏名・住所・連絡先などをできる範囲で機械的に除去する。
//   完全な匿名化は不可能だが「氏名・住所などの個人情報のみマスク」という
//   ユーザー方針を満たすため、以下を対象に置換する:
//     ・メールアドレス / 電話番号 / 郵便番号
//     ・住所（都道府県〜番地の連なり）
//     ・生年月日
//     ・「氏名/名前/フリガナ」ラベル行の値
//   スキル・職歴・経験などマッチングに必要な情報は残す。
// ------------------------------------------------------------
function maskPII(text) {
  let t = text

  // メールアドレス
  t = t.replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, '［メール］')

  // 電話番号（携帯: 0X0-XXXX-XXXX / 固定: 0X-XXXX-XXXX 等、区切り必須）
  //   ※職歴の期間「2015-2020」を誤検出しないよう、先頭0固定＋区切り記号を必須にする。
  t = t.replace(/(?:\+?81[-\s]?)?0\d{1,3}[-\(\)\s]\d{1,4}[-\(\)\s]\d{3,4}/g, '［電話番号］')
  // 区切りなし携帯（070/080/090 + 8桁）
  t = t.replace(/\b0[789]0\d{8}\b/g, '［電話番号］')

  // 郵便番号 〒123-4567 / 123-4567
  t = t.replace(/〒\s?\d{3}[-−]?\d{4}/g, '［郵便番号］')
  t = t.replace(/\b\d{3}[-−]\d{4}\b(?=\s*(?:東京|大阪|北海道|京都|[都道府県]|\n))/g, '［郵便番号］')

  // 生年月日（西暦/和暦、年月日。「年月日」が揃うものだけ＝職歴期間を壊さない）
  t = t.replace(/(?:19|20)\d{2}\s?[年\/\-\.]\s?\d{1,2}\s?[月\/\-\.]\s?\d{1,2}\s?日/g, '［生年月日］')
  t = t.replace(/(?:昭和|平成|令和)\s?\d{1,2}\s?年\s?\d{1,2}\s?月\s?\d{1,2}\s?日?/g, '［生年月日］')

  // 住所（都道府県 + 市区町村 + 以降の番地等をまとめてマスク）
  //   例: 東京都渋谷区神南1-2-3 マンション名101 → ［住所］
  const pref = '(?:北海道|青森県|岩手県|宮城県|秋田県|山形県|福島県|茨城県|栃木県|群馬県|埼玉県|千葉県|東京都|神奈川県|新潟県|富山県|石川県|福井県|山梨県|長野県|岐阜県|静岡県|愛知県|三重県|滋賀県|京都府|大阪府|兵庫県|奈良県|和歌山県|鳥取県|島根県|岡山県|広島県|山口県|徳島県|香川県|愛媛県|高知県|福岡県|佐賀県|長崎県|熊本県|大分県|宮崎県|鹿児島県|沖縄県)'
  // 住所ラベル行（「現住所」「住所」に続く値）を優先的にマスク
  t = t.replace(new RegExp('(現住所|住所|所在地)\\s*[:：]?\\s*' + pref + '[^\\n]{0,40}', 'g'), '$1: ［住所］')
  // ラベルの無い住所（都道府県+番地らしき数字を含む）
  t = t.replace(new RegExp(pref + '[^\\n]{0,15}?(?:市|区|郡|町|村)[^\\n]{0,25}?\\d[-−丁目番地号\\d\\s]*', 'g'), '［住所］')

  // 住所ラベル（英語 Address: 行も対象）
  t = t.replace(/(Address)\s*[:：]\s*[^\n]{1,60}/gi, '$1: ［住所］')

  // 氏名・フリガナのラベル行（値をマスク。日本語＋英語 Name:）
  t = t.replace(/(氏\s?名|名\s?前|フリガナ|ふりがな|カナ氏名|Name)\s*[:：]\s*[^\n]{1,20}/gi, '$1: ［氏名］')

  return t
}

// ------------------------------------------------------------
// 書類テキスト → 求人マッチング用の要約(JSON)
//   smartModel で、経験職種・スキル・業界・年数・志向・強みなどを構造化抽出。
// ------------------------------------------------------------
const RESUME_SYSTEM = `あなたは人材紹介のプロのキャリアアドバイザーです。
求職者の職務経歴書/履歴書のテキスト（個人情報はマスク済み）を読み、
その人が「目指せる求人」を探すために有用な情報だけを構造化して抽出してください。

重要:
- マスクされた個人情報（［氏名］［住所］［電話番号］等）は無視する。
- 事実に基づいて要約し、書類に無い情報を創作しない。
- 求人検索・マッチングに役立つ観点（経験職種・スキル・業界・実績・志向）に集中する。

必ず次のJSON形式のみで返answer:
{
  "summary": "この人の職務経歴の要約（200字程度、どんな経験を積んできたか）",
  "jobTypes": ["経験のある職種（例: 法人営業, カスタマーサクセス）"],
  "industries": ["経験のある業界"],
  "skills": ["スキル/強み（例: 新規開拓, マネジメント, 英語）"],
  "yearsExperience": 総経験年数の数値または null,
  "seniority": "メンバー | リーダー | マネージャー | 役員 などの到達役職 または null",
  "reachableJobs": "この経歴なら目指せる求人の方向性（100字程度。希望条件と合わせて考えるための材料）"
}`

// ------------------------------------------------------------
// メイン: base64 PDF を解析して要約を返す
//   戻り値: { ok, resumeText(マスク済抜粋), analysis(JSON), tokensUsed, error }
//   ※ 元base64は受け取るだけで保持しない（呼び出し側で破棄）
// ------------------------------------------------------------
export async function analyzeResumePdf(env, base64) {
  if (!base64 || typeof base64 !== 'string') {
    return { ok: false, error: 'no-pdf' }
  }
  let text = ''
  try {
    // data URL プレフィックスがあれば除去
    const b64 = base64.includes(',') ? base64.slice(base64.indexOf(',') + 1) : base64
    const buf = Buffer.from(b64, 'base64')
    // 簡易マジックナンバーチェック（%PDF）
    if (buf.slice(0, 4).toString('latin1') !== '%PDF') {
      return { ok: false, error: 'not-a-pdf' }
    }
    const parsed = await pdfParse(buf)
    text = sanitizeText(parsed.text || '')
  } catch (e) {
    return { ok: false, error: `pdf-parse: ${e.message}` }
  }

  if (!text.trim()) {
    return { ok: false, error: 'empty-text（画像PDF等でテキスト抽出不可の可能性）' }
  }

  // PIIマスク → OpenAI送信用テキスト（長すぎる場合は先頭を優先して切り詰め）
  const masked = maskPII(text).slice(0, 12000)

  // smartModel で構造化要約
  let analysis = null
  let tokensUsed = 0
  try {
    const res = await fetch(`${env.OPENAI_BASE_URL}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${env.OPENAI_API_KEY}` },
      body: JSON.stringify({
        model: smartModel(env),
        messages: [
          { role: 'system', content: RESUME_SYSTEM },
          { role: 'user', content: `職務経歴書/履歴書（個人情報マスク済み）:\n\n${masked}` },
        ],
        response_format: { type: 'json_object' },
        reasoning_effort: 'medium',
        max_completion_tokens: 3000,
      }),
    })
    if (!res.ok) {
      return { ok: false, error: `OpenAI(resume) ${res.status}: ${(await res.text()).slice(0, 200)}` }
    }
    const data = await res.json()
    tokensUsed = data.usage?.total_tokens ?? 0
    try { analysis = JSON.parse(data.choices?.[0]?.message?.content ?? '{}') } catch { analysis = {} }
  } catch (e) {
    return { ok: false, error: `OpenAI(resume): ${e.message}` }
  }

  return { ok: true, analysis, tokensUsed, maskedPreview: masked.slice(0, 500) }
}

// ------------------------------------------------------------
// 解析結果(analysis) → criteria に反映するテキスト化
//   buildSearchPlans / criteriaToText で使う人間可読の要約文。
// ------------------------------------------------------------
export function resumeAnalysisToText(analysis) {
  if (!analysis || typeof analysis !== 'object') return ''
  const parts = []
  if (analysis.summary) parts.push(`【職務経歴の要約】${analysis.summary}`)
  if (Array.isArray(analysis.jobTypes) && analysis.jobTypes.length) parts.push(`【経験職種】${analysis.jobTypes.join('、')}`)
  if (Array.isArray(analysis.industries) && analysis.industries.length) parts.push(`【経験業界】${analysis.industries.join('、')}`)
  if (Array.isArray(analysis.skills) && analysis.skills.length) parts.push(`【スキル/強み】${analysis.skills.join('、')}`)
  if (analysis.yearsExperience != null) parts.push(`【経験年数】約${analysis.yearsExperience}年`)
  if (analysis.seniority) parts.push(`【到達役職】${analysis.seniority}`)
  if (analysis.reachableJobs) parts.push(`【目指せる求人の方向性】${analysis.reachableJobs}`)
  return parts.join('\n')
}
