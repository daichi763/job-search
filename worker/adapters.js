import {
  OCCUPATIONS, INDUSTRIES, PREFECTURES, EDUCATION, REQUIRED_GENDERS,
  AVERAGE_OVERTIMES, EMPLOYMENT_TYPES, POSITIONS, CAREER_STAGES,
} from './circus_master.js'

// ============================================================
// 各求人サイトのスクレイピング・アダプタ
//
// 各アダプタは共通インターフェイスを実装します:
//   - source: DB識別子
//   - login(page, env): ログイン処理
//   - fetchJobs(page, criteria, onJob): 求人を検索・抽出し、1件ごとに onJob(job) を呼ぶ
//
// onJob に渡す job オブジェクトは Cloudflare側の NormalizedJob 形式:
//   { source, sourceJobId, title, company, jobCategory, industry, employment,
//     locations:[], salaryMin, salaryMax, overtime, holiday, benefits,
//     requirements, description, url, isOpen }
// ============================================================

// ------------------------------------------------------------
// 共通ユーティリティ
// ------------------------------------------------------------

// 「300万円～360万円（月給 25万円〜30万円）」→ { min: 3000000, max: 3600000 }
// 「（月給 ...）」以降は月給表記なので年収レンジからは除外する。
export function parseSalary(text) {
  if (!text) return { min: null, max: null }
  let t = String(text)
  // 「（月給...）」「(月給...)」括弧内は年収ではないので除去
  t = t.replace(/[（(]\s*月給[\s\S]*?[)）]/g, '')
  // 括弧が残る場合も月給・月収・時給が含まれる括弧は除去
  t = t.replace(/[（(][^（）()]*(月給|月収|時給|日給)[^（）()]*[)）]/g, '')

  // 年収レンジ「300万円～360万円」「300万〜360万」等（全角/半角チルダ・ハイフン対応）
  const manMatches = [...t.matchAll(/(\d{2,5})\s*万/g)].map((m) => parseInt(m[1], 10) * 10000)
  // 円単位の直接記載「3,000,000円」も拾う（100万円以上のみ = 年収相当）
  const yenMatches = [...t.matchAll(/([\d,]{5,})\s*円/g)]
    .map((m) => parseInt(m[1].replace(/,/g, ''), 10))
    .filter((n) => n >= 1000000)
  const all = [...manMatches, ...yenMatches].filter((n) => Number.isFinite(n) && n >= 1000000)
  if (all.length === 0) return { min: null, max: null }
  const min = Math.min(...all)
  const max = Math.max(...all)
  return { min, max: max === min ? null : max }
}

// ラベル→値 抽出: 改行区切りテキストで「ラベル」の次行を値とみなす
// - stopLabels 未指定: 直後の非空行1つを単一値として返す
// - stopLabels 指定: stopLabel（または部分一致）に達するまでの複数行を連結して返す
export function extractByLabel(lines, label, stopLabels = []) {
  // ラベルは行全体一致 or タブ区切りの先頭要素一致（例: "応募必須条件\t書類見送りの主な理由"）
  const idx = lines.findIndex((l) => {
    const s = l.trim()
    return s === label || s.split('\t')[0].trim() === label
  })
  if (idx === -1) return ''
  const out = []
  for (let i = idx + 1; i < lines.length; i++) {
    const raw = lines[i]
    const line = raw.trim()
    if (stopLabels.length === 0) {
      if (!line) continue
      return line // 単一値
    }
    // 複数行モード
    const head = line.split('\t')[0].trim()
    if (stopLabels.some((s) => line === s || head === s)) break
    if (!line) continue
    out.push(line)
  }
  return out.join('\n').trim()
}

// 勤務地文字列から都道府県群を抽出
const PREF_RE = /(北海道|青森|岩手|宮城|秋田|山形|福島|茨城|栃木|群馬|埼玉|千葉|東京|神奈川|新潟|富山|石川|福井|山梨|長野|岐阜|静岡|愛知|三重|滋賀|京都|大阪|兵庫|奈良|和歌山|鳥取|島根|岡山|広島|山口|徳島|香川|愛媛|高知|福岡|佐賀|長崎|熊本|大分|宮崎|鹿児島|沖縄)/g
export function parseLocations(text) {
  if (!text) return []
  const found = [...String(text).matchAll(PREF_RE)].map((m) => m[1])
  return [...new Set(found)]
}

// ------------------------------------------------------------
// ①circusAGENT (Next.js SPA / MUIテーブル)
// ------------------------------------------------------------

// circus /search の qJson `option` = 検索対象フィールド（Playwrightで実測確定）。
// 機能A（AIが検索条件を自動構築）で、AIに「どのフィールドを検索対象にするか」を
// 選ばせる際のマッピングとして使用する。
export const CIRCUS_FIELD = {
  COMPANY_NAME: 1,    // 求人企業名
  JOB_TITLE: 2,       // 求人タイトル
  BUSINESS: 3,        // 事業内容と今後の事業展開
  JOB_CONTENT: 4,     // 仕事内容
  QUALIFICATION: 5,   // 応募資格・内定の可能性が高い人
  AGENT_NAME: 6,      // 求人取扱企業名
  JOB_ID: 7,          // 求人ID
  FULLTEXT: 8,        // 掲載内容全体（＝真の全文検索。最も網羅的）
  COMPANY_ID: 9,      // 企業ID
}
// option 番号 → 表示名（デバッグ/ログ用の逆引き）
export const CIRCUS_FIELD_LABEL = {
  1: '求人企業名', 2: '求人タイトル', 3: '事業内容と今後の事業展開', 4: '仕事内容',
  5: '応募資格・内定の可能性が高い人', 6: '求人取扱企業名', 7: '求人ID',
  8: '掲載内容全体', 9: '企業ID',
}
// circus のロジック種別（キーワード欄の各行に指定できる論理）
export const CIRCUS_LOGIC = {
  AND: 'and', OR: 'or', NOT_AND: 'excludeAnd', NOT_OR: 'excludeOr',
}

// 機能A: 「さらに詳しい条件」画面の操作対象マップ（Playwrightで実測確定）。
// チェックボックスはラベル完全一致テキストでクリック、select/inputはname属性で操作する。
export const CIRCUS_COND = {
  // select[name] で選択（値はラベル文字列）
  selects: {
    gender: { name: 'requiredGenders', options: ['男性', '女性'] },
    education: { name: 'education', options: ['高卒', '専門卒', '短大卒', '大卒', '大学院卒', '学歴不問'] },
    overtime: { name: 'averageOvertimes', options: ['残業なし', '10時間以下', '20時間以下', '30時間以下', '40時間以下', '50時間以下'] },
  },
  // input[name] に文字入力（数値）
  inputs: {
    age: 'age',
    salaryInclude: 'annualSalary.include',
    salaryMin: 'annualSalary.min',
    salaryMax: 'annualSalary.max',
  },
  // チェックボックス（ラベル完全一致でクリック）。カテゴリごとに整理。
  checkboxes: {
    employment: ['正社員', '契約社員', 'アルバイト', '業務委託'],
    position: ['新卒採用', '中途採用'],
    rank: ['経営陣', '事業責任者', '管理職（課長・部長）', 'リーダー', 'メンバー'],
    background: ['欠員募集', '増員募集', '新規部署立ち上げ', '更なる組織強化', '組織・事業立て直し', 'IPOに向けて'],
    companyPhase: ['中小', 'ベンチャー', 'メガベンチャー', '大手'],
    listing: ['上場企業', '非上場企業'],
    employeeCount: ['10名未満', '10 ~ 30名', '31 ~ 50名', '51 ~ 100名', '101 ~ 300名', '301 ~ 500名', '501 ~ 1000名', '1001 ~ 5000名', '5001名以上'],
    businessService: ['C向けサービス', 'B向けサービス', '10億円以上の資金調達をしている', '3年以内に上場を目指している', '過去3年以内にM&Aをした', '過去3年以内に上場をした', '新規事業開発（事業多角化）に意欲的'],
    salaryReward: ['インセンティブ制度あり', '賞与あり', 'ストックオプションあり'],
    holiday: ['土日祝休み', '土日休み', '週休2日（土日以外）', 'シフト制', 'その他'],
    workEnv: ['年間休日120日以上', 'フレックス勤務', '時短勤務あり', '副業OK', 'リモートワークOK', '転勤なし'],
    benefits: ['社会保険完備', '交通費支給', '住宅手当', '社宅・寮', '健康診断', '家族手当', '役職手当', '資格手当', '退職金制度', '資格取得制度', '持株会制度', '社員割引制度'],
    workStyle: ['客先常駐勤務', '自社内勤務'],
    coworkers: ['20代が多い', '30代が多い', '40代が多い', '男性が多い', '女性が多い'],
    culture: ['競争環境（個人主義・一気通貫型）', '協業環境（全体主義・プロジェクト型）', '論理的な人が多い（ロジカルタイプ）', '行動的な人が多い（パッションタイプ）'],
    // 応募資格系の絞り込みチェック（画面上部）
    experience: ['職種未経験OK', '職種未経験NG', '業種未経験OK', '業種未経験NG', '外国籍OK'],
  },
}

export const circusAdapter = {
  source: 'circus',
  base: 'https://circus-job.com',

  async login(page, env) {
    const loginUrl = env.CIRCUS_LOGIN_URL || 'https://circus-job.com/login'
    await page.goto(loginUrl, { waitUntil: 'networkidle', timeout: 45000 })
    await page.waitForTimeout(1500)

    // 既にログイン済みでダッシュボード等へリダイレクトされた場合はスキップ
    const emailField = await page.$('input[name="email"]')
    if (!emailField) {
      if (!page.url().includes('/login')) return // 既にログイン済み
      // フォーム描画待ち（SPA遅延）
      await page.waitForSelector('input[name="email"]', { timeout: 20000 })
    }

    await page.fill('input[name="email"]', env.CIRCUS_ID)
    await page.fill('input[name="password"]', env.CIRCUS_PW)
    await page.click('button[type="submit"]')
    await page.waitForTimeout(2500)

    // シングルセッション制限: 「このアカウントは現在使用中です」ダイアログ処理
    // ⚠️ 注意: ここで「ログインする」を押すと、実際に使用中の人がログアウトされます。
    const body = await page.innerText('body').catch(() => '')
    if (body.includes('現在使用中') || body.includes('本当にログイン')) {
      const btns = await page.$$('button')
      for (const b of btns.reverse()) {
        const t = (await b.innerText().catch(() => '')).trim()
        if (t === 'ログインする') {
          await b.click()
          break
        }
      }
      await page.waitForTimeout(3500)
    }

    // ログイン成功確認: /jobs や /home へ遷移しているか、ログインフォームが消えたか
    const url = page.url()
    if (url.includes('/login')) {
      const still = await page.$('input[name="password"]')
      if (still) throw new Error('circusログイン失敗（認証情報またはダイアログ処理を確認）')
    }
  },

  // ==========================================================
  // 【API直接方式】 circus 内部REST API を直接叩く（画面操作を経由しない）。
  // UI操作方式(fetchJobsPaged/applyConditions)より高速・確実。
  //   認証: x-circus-authentication-token ヘッダ（UUID）。/search を一度
  //         ロードすると発火するリクエストから捕捉できる。
  //   検索: GET /api/jobSearch?qJson=...(×4)&<filters>&limit&offset&page
  //   件数: GET /api/jobSearchMatches?...(同一params) → マッチ件数のみ
  // ==========================================================

  // /search をロードして x-circus-authentication-token を捕捉する。
  // login(page, env) 済みの page を渡すこと。
  async getAuthToken(page) {
    let token = null
    const handler = (r) => {
      const h = r.headers()
      if (h['x-circus-authentication-token'] && !token) token = h['x-circus-authentication-token']
    }
    page.on('request', handler)
    try {
      await page.goto(`${this.base}/search`, { waitUntil: 'networkidle', timeout: 60000 })
      // トークンを載せたリクエストが飛ぶまで少し待つ
      for (let t = 0; t < 10 && !token; t++) {
        await page.waitForTimeout(700)
      }
    } finally {
      page.off('request', handler)
    }
    if (!token) throw new Error('circus 認証トークン(x-circus-authentication-token)の取得に失敗しました')
    return token
  }, // getAuthToken

  // qJson(4要素) を組み立てる。option=8=掲載内容全体（真の全文）が既定。
  //   terms: { and, or, excludeAnd, excludeOr } いずれも文字列（空可）。
  buildQJson(terms = {}, option) {
    const opt = option || parseInt(process.env.CIRCUS_SEARCH_OPTION || '8', 10)
    return [
      { option: opt, keyword: terms.and || '', logicType: 'and' },
      { option: opt, keyword: terms.or || '', logicType: 'or' },
      { option: opt, keyword: terms.excludeAnd || '', logicType: 'excludeAnd' },
      { option: opt, keyword: terms.excludeOr || '', logicType: 'excludeOr' },
    ]
  },

  // filters(コード群)→ URLSearchParams用の extra オブジェクトへ変換。
  // 値は配列可（複数選択）。circus APIは同名キーを複数回 append する形式。
  //   filters: {
  //     occupations:[..], industries:[..], prefectures:[..],
  //     education:N, requiredGenders:N, averageOvertimes:N, age:N,
  //     annualSalaryInclude:N, employmentTypes:[..], careerStage:N, ...
  //   }
  // 戻り値: [ [key, value], ... ] の配列（append 用に順序保持）
  filtersToPairs(filters = {}) {
    const pairs = []
    const pushMulti = (key, val) => {
      if (val == null) return
      const arr = Array.isArray(val) ? val : [val]
      for (const v of arr) if (v !== '' && v != null) pairs.push([key, String(v)])
    }
    pushMulti('occupations', filters.occupations)
    pushMulti('industries', filters.industries)
    pushMulti('prefectures', filters.prefectures)
    pushMulti('employmentTypes', filters.employmentTypes)
    if (filters.education != null) pairs.push(['education', String(filters.education)])
    if (filters.requiredGenders != null) pairs.push(['requiredGenders', String(filters.requiredGenders)])
    if (filters.averageOvertimes != null) pairs.push(['averageOvertimes', String(filters.averageOvertimes)])
    if (filters.age != null) pairs.push(['age', String(filters.age)])
    if (filters.careerStage != null) pairs.push(['careerStage', String(filters.careerStage)])
    if (filters.annualSalaryInclude != null) pairs.push(['annualSalary.include', String(filters.annualSalaryInclude)])
    if (filters.annualSalaryMin != null) pairs.push(['annualSalary.min', String(filters.annualSalaryMin)])
    if (filters.annualSalaryMax != null) pairs.push(['annualSalary.max', String(filters.annualSalaryMax)])
    // 任意の生パラメータ（将来拡張・未マップコード用）
    if (filters.raw && typeof filters.raw === 'object') {
      for (const [k, v] of Object.entries(filters.raw)) pushMulti(k, v)
    }
    return pairs
  },

  // ブラウザ内 fetch で API を叩く共通処理。
  //   endpoint: 'jobSearch' | 'jobSearchMatches'
  //   returns: jobSearch → { jobs:[], total:N }, jobSearchMatches → { matches:N } (rawも返す)
  async _apiCall(page, token, endpoint, { qJson, filters, limit = 25, offset = 0, pageNo = 1 } = {}) {
    const pairs = this.filtersToPairs(filters || {})
    return await page.evaluate(async ({ token, endpoint, qJson, pairs, limit, offset, pageNo }) => {
      const qs = new URLSearchParams()
      for (const q of qJson) qs.append('qJson', JSON.stringify(q))
      qs.set('limit', String(limit))
      qs.set('offset', String(offset))
      qs.set('page', String(pageNo))
      qs.set('orderBy', 'recommendScore')
      qs.set('order', 'desc')
      for (const [k, v] of pairs) qs.append(k, v)
      const url = `https://circus-job.com/api/${endpoint}?` + qs.toString()
      const res = await fetch(url, {
        credentials: 'include',
        headers: { 'accept': 'application/json, text/plain, */*', 'x-circus-authentication-token': token },
      })
      const status = res.status
      let json = null
      try { json = await res.json() } catch {}
      return { status, json }
    }, { token, endpoint, qJson, pairs, limit, offset, pageNo })
  },

  // 求人検索（本体）。params = { qJson, filters, limit, offset, pageNo }
  // 戻り値: { total:Number, jobs:[生API job], status }
  async apiSearch(page, token, params = {}) {
    const { status, json } = await this._apiCall(page, token, 'jobSearch', params)
    if (status !== 200 || !json) {
      throw new Error(`circus apiSearch 失敗 status=${status}`)
    }
    return { total: json.total ?? null, jobs: Array.isArray(json.jobs) ? json.jobs : [], status }
  },

  // マッチ件数のみ取得（機能Aの件数→条件調整ループ用。求人本体は取らないので軽量）。
  // 戻り値: Number（件数）または null
  async apiCount(page, token, params = {}) {
    const { status, json } = await this._apiCall(page, token, 'jobSearchMatches', { ...params, limit: 1 })
    if (status !== 200 || !json) return null
    // レスポンスキーは環境により matches / total / count 等の可能性。総当たりで数値を拾う。
    const cand = json.matches ?? json.total ?? json.count ?? json.totalCount ?? json.hitCount
    if (typeof cand === 'number') return cand
    // jobSearchMatches が {total} を返さない場合、jobSearch の total で代替（保険）
    for (const v of Object.values(json)) if (typeof v === 'number') return v
    return null
  },

  // ==========================================================
  // 【機能B（詳細取得）＝API直接方式】
  // /api/jobSearch の生 job オブジェクトを内部 NormalizedJob 形式へ変換する。
  // 別途の詳細ページ取得は不要（jobSearch レスポンスに詳細情報が全部含まれる）。
  //   生 job の主要フィールド（probe_apishape.js 実測）:
  //     id, name(タイトル), occupations{main,sub[]}, employmentTypes[],
  //     careerStage, positions[], jobDescriptions(仕事内容),
  //     addresses[{prefecture}], expectedAnnualSalary{min,max}(万円),
  //     requiredAges{min,max}, requiredGender, requiredEducation,
  //     minimumQualification(応募資格), company{name,industries{main,sub},website},
  //     open, publishStartedAt, lastUpdatedAt
  // ==========================================================
  mapApiJob(raw) {
    if (!raw) return null
    const labelOf = (map, code) => {
      const e = map[String(code)]
      return e ? (typeof e === 'object' ? e.label : e) : null
    }

    // 職種: main + sub をラベル化
    const occCodes = []
    if (raw.occupations) {
      if (raw.occupations.main != null) occCodes.push(raw.occupations.main)
      if (Array.isArray(raw.occupations.sub)) occCodes.push(...raw.occupations.sub)
    }
    const jobCategories = occCodes.map((c) => labelOf(OCCUPATIONS, c)).filter(Boolean)

    // 業種: company.industries main + sub
    const indCodes = []
    const comp = raw.company || {}
    if (comp.industries) {
      if (comp.industries.main != null) indCodes.push(comp.industries.main)
      if (Array.isArray(comp.industries.sub)) indCodes.push(...comp.industries.sub)
    }
    const industries = indCodes.map((c) => labelOf(INDUSTRIES, c)).filter(Boolean)

    // 勤務地: addresses[].prefecture → 都道府県ラベル（重複除去）
    const prefLabels = []
    if (Array.isArray(raw.addresses)) {
      for (const a of raw.addresses) {
        const l = labelOf(PREFECTURES, a && a.prefecture)
        if (l && !prefLabels.includes(l)) prefLabels.push(l)
      }
    }

    // 雇用形態
    const employment = (Array.isArray(raw.employmentTypes) ? raw.employmentTypes : [])
      .map((c) => labelOf(EMPLOYMENT_TYPES, c)).filter(Boolean)

    // 年収: 万円単位 → 円
    const sal = raw.expectedAnnualSalary || {}
    const salaryMin = typeof sal.min === 'number' ? Math.round(sal.min * 10000) : null
    const salaryMax = typeof sal.max === 'number' ? Math.round(sal.max * 10000) : null

    // 応募条件（年齢/性別/学歴）— HIGH優先の確定データ
    const ages = raw.requiredAges || {}
    const requiredAgeMin = typeof ages.min === 'number' ? ages.min : null
    const requiredAgeMax = typeof ages.max === 'number' ? ages.max : null
    const requiredGender = labelOf(REQUIRED_GENDERS, raw.requiredGender) // null=不問
    const requiredEducation = labelOf(EDUCATION, raw.requiredEducation)  // null=不明

    // 成果報酬（紹介手数料）— circus APIの生データから柔軟に抽出。
    //   媒体により「理論年収×N%」型 と「一律◯万円」型 がある。
    //   フィールド名は媒体差があるため候補を総当たりで拾う。
    const reward = this.extractReward(raw)

    return {
      source: 'circus',
      sourceJobId: String(raw.id),
      title: raw.name || '',
      company: comp.name || '',
      companyWebsite: comp.website || '',
      jobCategory: jobCategories.join('・'),
      jobCategories,              // 配列も保持（採点用）
      industry: industries.join('・'),
      industries,
      employment: employment.join('・'),
      locations: prefLabels,      // 県レベル（ユーザ指示: 県 or 市で十分）
      salaryMin,
      salaryMax,
      // 応募条件（確定データ = HIGH優先）
      requiredAgeMin,
      requiredAgeMax,
      requiredGender,
      requiredEducation,
      reward,                     // 成果報酬（{ type, rate, amount, text }）
      requirements: raw.minimumQualification || '',
      description: raw.jobDescriptions || '',
      positions: (Array.isArray(raw.positions) ? raw.positions : [])
        .map((c) => labelOf(POSITIONS, c)).filter(Boolean),
      careerStage: labelOf(CAREER_STAGES, raw.careerStage),
      url: `${this.base}/search/${raw.id}`,
      isOpen: raw.open !== false,
      publishStartedAt: raw.publishStartedAt || null,
      lastUpdatedAt: raw.lastUpdatedAt || null,
      _raw: raw,                  // 生データも保持（デバッグ・追加抽出用）
    }
  }, // mapApiJob

  // ==========================================================
  // 成果報酬（紹介手数料）抽出
  //   circus API 生データから報酬情報を柔軟に拾う。
  //   フィールド名は媒体/バージョンで揺れるため候補を総当たり。
  //   戻り値: { type:'rate'|'fixed'|'unknown', rate, amount, text }
  //     rate  : 理論年収に対する％（数値、例 30）
  //     amount: 固定額（円、例 600000）
  //     text  : 表示用の元テキスト（あれば）
  // ==========================================================
  extractReward(raw) {
    if (!raw || typeof raw !== 'object') return { type: 'unknown', rate: null, amount: null, text: '' }

    // ★ circus 実データで確定したフィールド（probe_reward.js検証済）:
    //   raw.commissionFee = { id, fee }  fee は「理論年収に対する率(%)」（例 fee:45 → 理論年収×45%）
    //   人材紹介の成果報酬は理論年収の30〜45%が業界標準のため、この値は率(%)として扱う。
    //   （万一 fee が桁の大きい固定額で来た場合の保険も入れる: 200以上は円/万円とみなす）
    if (raw.commissionFee && typeof raw.commissionFee === 'object' && raw.commissionFee.fee != null) {
      const f = typeof raw.commissionFee.fee === 'number'
        ? raw.commissionFee.fee
        : parseFloat(String(raw.commissionFee.fee).replace(/[, ]/g, ''))
      if (Number.isFinite(f) && f > 0) {
        if (f <= 100) {
          // 率(%)として扱う（通常ケース）
          return { type: 'rate', rate: f, amount: null, text: '' }
        }
        // 100超 = 固定額の可能性。1000未満は万円とみなし円換算。
        const amount = f < 1000 ? f * 10000 : f
        return { type: 'fixed', rate: null, amount, text: '' }
      }
    }

    // ％系フィールド候補（理論年収×N%）
    const rateKeys = [
      'rewardRate', 'feeRate', 'commissionRate', 'referralFeeRate',
      'successFeeRate', 'rewardPercentage', 'feePercentage', 'refundRate',
    ]
    // 固定額系フィールド候補（円 or 万円）
    const amountKeys = [
      'rewardAmount', 'feeAmount', 'commissionAmount', 'referralFee',
      'successFee', 'reward', 'fee', 'commission',
    ]
    // テキスト系（そのまま表示できる説明）
    const textKeys = [
      'rewardText', 'feeText', 'rewardDescription', 'feeDescription',
      'rewardNote', 'commissionText',
    ]

    const num = (v) => {
      if (typeof v === 'number' && !isNaN(v)) return v
      if (typeof v === 'string') {
        const m = v.replace(/[, ]/g, '').match(/-?\d+(\.\d+)?/)
        if (m) return parseFloat(m[0])
      }
      return null
    }

    // 1) ％
    let rate = null
    for (const k of rateKeys) {
      if (raw[k] != null) { const n = num(raw[k]); if (n != null) { rate = n; break } }
    }
    // ネストした reward オブジェクトも探索
    const rObj = (raw.reward && typeof raw.reward === 'object') ? raw.reward
      : (raw.fee && typeof raw.fee === 'object') ? raw.fee : null
    if (rate == null && rObj) {
      for (const k of ['rate', 'percentage', 'percent']) {
        if (rObj[k] != null) { const n = num(rObj[k]); if (n != null) { rate = n; break } }
      }
    }

    // 2) 固定額（円換算。万円らしき小さい値は×10000）
    let amount = null
    for (const k of amountKeys) {
      const v = raw[k]
      if (v != null && typeof v !== 'object') { const n = num(v); if (n != null) { amount = n; break } }
    }
    if (amount == null && rObj) {
      for (const k of ['amount', 'value', 'fixed']) {
        if (rObj[k] != null) { const n = num(rObj[k]); if (n != null) { amount = n; break } }
      }
    }
    // 万円判定: 1000未満なら万円とみなし円換算（例: 60 → 600,000円）
    if (amount != null && amount > 0 && amount < 1000) amount = amount * 10000

    // 3) テキスト
    let text = ''
    for (const k of textKeys) {
      if (typeof raw[k] === 'string' && raw[k].trim()) { text = raw[k].trim(); break }
    }
    if (!text && rObj && typeof rObj.text === 'string') text = rObj.text.trim()

    if (rate != null) return { type: 'rate', rate, amount, text }
    if (amount != null) return { type: 'fixed', rate: null, amount, text }
    if (text) return { type: 'unknown', rate: null, amount: null, text }
    return { type: 'unknown', rate: null, amount: null, text: '' }
  },


  // freeText からキーワード候補を抽出する。
  // circusの検索は「フレーズ的」で、長文を入れるとヒット0になりやすい。
  // 名詞的な短い語（職種名など）を優先的に1〜数語だけ拾う。
  // 明示的な keyword が指定(criteria.keyword)されていればそれを最優先。
  extractKeyword(criteria) {
    if (criteria.keyword && criteria.keyword.trim()) return criteria.keyword.trim()
    const ft = (criteria.freeText || '').trim()
    if (!ft) return ''
    // 職種カテゴリが選択されていればそれを使う
    if (Array.isArray(criteria.jobCategories) && criteria.jobCategories.length) {
      return criteria.jobCategories[0]
    }
    // よくある職種・業種キーワードを freeText から検出
    const KNOWN = ['営業', 'エンジニア', '事務', '経理', '人事', 'マーケティング', '企画',
      '販売', '看護', '介護', 'デザイナー', 'コンサル', '製造', '施工', '建築', '医療',
      'IT', 'プログラマ', 'ドライバー', '接客', '管理', '開発', 'データ', '財務', '総務']
    for (const k of KNOWN) if (ft.includes(k)) return k
    return '' // 見つからなければキーワード無し（全求人をrecommendScore順に取得しAI採点で絞る）
  },

  // 検索ページのURLを構築。
  // キーワードは or ロジックに入れる（短い語のみ。無ければ全求人）。
  // フリー記述の細かなニュアンスは後段のAI採点で反映する。
  //
  // circus /search の qJson の option は「検索対象フィールド」を表す（実測で確定）:
  //   CIRCUS_FIELD 定数参照。option=8=掲載内容全体 が真の全文検索（最も網羅的）。
  //   ※前回 option=4 を「全文」と誤記していたが、実際は「仕事内容」フィールドだった。
  // 「見つけづらい求人も網羅」する理想には option=8(掲載内容全体) が最適。
  // キーワードは or に入れる（AIが抽出した短い語。無ければ全求人が対象）。
  //
  // /search は 1ページ25件のページネーション型。&page=N で正しくページ送りできる
  // （数万件ヒットする状態では page=1,2,3... が重複なく機能することを確認済み）。
  buildSearchUrl(criteria, pageNo = 1) {
    const kw = this.extractKeyword(criteria)
    const option = parseInt(process.env.CIRCUS_SEARCH_OPTION || '8', 10) // 既定=8(掲載内容全体=真の全文)
    const qJson = encodeURIComponent(
      JSON.stringify([
        { option, keyword: '', logicType: 'and' },
        { option, keyword: kw, logicType: 'or' },
        { option, keyword: '', logicType: 'excludeAnd' },
        { option, keyword: '', logicType: 'excludeOr' },
      ])
    )
    return (
      `${this.base}/search?qJson=${qJson}` +
      `&selectionDaysIncludingDuringMeasurement=included` +
      `&page=${pageNo}&orderBy=recommendScore&order=desc&resume.selectionCount=`
    )
  },

  // 検索結果の総件数を読み取る（「28,817件」等）。取得できなければ null。
  async readTotalCount(page) {
    // 総件数は「検索結果一覧」直後の数字。DOMは
    //   検索結果一覧<div>{N}</div>件 (1-25件目を表示)
    // という構造。innerText では「検索結果一覧\n{N}\n件 (1-25件目を表示)」。
    // 「詳しい条件」パネルを開くと本文に "3件以上" 等のラベルが混ざるため、
    // 単純な /([\d,]+)\s*件/ では誤検知する。必ず「検索結果一覧」を起点に読む。
    const body = await page.innerText('body').catch(() => '')
    // パターン1: 検索結果一覧 <数字> 件 (1-25件目を表示)
    let m = body.match(/検索結果一覧\s*([\d,]+)\s*件/)
    // パターン2: <数字>件 (X-Y件目を表示) — 一覧見出しが取れない場合の保険
    if (!m) m = body.match(/([\d,]+)\s*件\s*\(\s*\d+\s*[-–]\s*\d+\s*件目を表示/)
    if (!m) return null
    const n = parseInt(m[1].replace(/,/g, ''), 10)
    return Number.isFinite(n) ? n : null
  },

  // SPAの検索初期化を待つ。qJson付きURLへ直接gotoすると、件数やカードが
  // 非同期で確定するまで 0件/中途半端な件数 になる。件数が安定し、かつ
  // カードが最低1枚描画されるまで待つ。ダメなら reload する。
  // 戻り値: { total, ok } — ok=false ならこのページは取得不能。
  async waitForResults(page) {
    for (let attempt = 0; attempt < 3; attempt++) {
      let stableCount = null
      let sameStreak = 0
      // 件数が2回連続同じになるまで（最大 ~12秒）待つ
      for (let t = 0; t < 12; t++) {
        const n = await this.readTotalCount(page)
        if (n != null && n === stableCount) {
          sameStreak++
          if (sameStreak >= 1 && n > 0) break // 安定 & 0件でない
        } else {
          stableCount = n
          sameStreak = 0
        }
        await page.waitForTimeout(1000)
      }
      // カード描画を待つ（少しスクロールして誘発）
      for (let t = 0; t < 8; t++) {
        const c = await page.$$eval('[data-testid="job-search-result-card"]', (x) => x.length).catch(() => 0)
        if (c > 0) return { total: stableCount ?? 0, ok: true }
        await page.mouse.wheel(0, 600)
        await page.waitForTimeout(800)
      }
      // カードが出ない → reload して再試行
      if (attempt < 2) {
        await page.reload({ waitUntil: 'networkidle', timeout: 60000 }).catch(() => {})
        await page.waitForTimeout(3000)
      }
    }
    const finalTotal = await this.readTotalCount(page)
    const finalCards = await page.$$eval('[data-testid="job-search-result-card"]', (x) => x.length).catch(() => 0)
    return { total: finalTotal ?? 0, ok: finalCards > 0 }
  },

  // ページネーション型の /search を1ページ(25件)ずつ深掘りし、
  // 1ページ収集するごとに onPage(jobs[], meta) を呼ぶ。
  // onPage の戻り値が false なら探索を打ち切る（自律探索エージェント用）。
  // 総件数は最初の onPage 呼び出しで meta.total として渡す。
  // ページ番号は無制限に進めるが、実際の停止判断は呼び出し側(onPage)が行う。
  async fetchJobsPaged(page, criteria, onPage) {
    const PAGE_SIZE = 25
    const HARD_MAX_PAGES = parseInt(process.env.CIRCUS_HARD_MAX_PAGES || '5100', 10)
    const globalSeen = new Set()
    let total = null
    let metaSent = false

    for (let pageNo = 1; pageNo <= HARD_MAX_PAGES; pageNo++) {
      const url = this.buildSearchUrl(criteria, pageNo)
      await page.goto(url, { waitUntil: 'networkidle', timeout: 60000 })
      await page.waitForTimeout(2500)

      // SPA初期化を待つ（件数安定＋カード描画。ダメならreload）
      const { total: pageTotal, ok } = await this.waitForResults(page)
      if (total == null) {
        total = pageTotal
        console.log(`[circus] 検索結果 総件数=${total} 件`)
      }
      if (!ok) {
        // このページにカードが無い = 末尾 or 取得不能
        if (!metaSent) await onPage([], { total })
        break
      }

      // このページ内のカードを仮想スクロールで集めきる（DOMには常時2〜3枚）
      const pageJobs = []
      const pageSeen = new Set()
      let stagnant = 0
      for (let step = 0; step < 50; step++) {
        const cards = await this.readVisibleCards(page)
        let newInThisStep = 0
        for (const card of cards) {
          if (!card.id || pageSeen.has(card.id)) continue
          pageSeen.add(card.id)
          newInThisStep++
          if (globalSeen.has(card.id)) continue // 別ページで既出（重複防止）
          globalSeen.add(card.id)
          try {
            const job = this.cardToJob(card)
            if (job) pageJobs.push(job)
          } catch (e) {
            console.error(`circus カード解析失敗 id=${card.id}:`, e.message)
          }
        }
        if (newInThisStep === 0) stagnant++
        else stagnant = 0
        if (stagnant >= 8) break
        if (pageSeen.size >= PAGE_SIZE) break
        await page.mouse.wheel(0, 1200)
        await page.waitForTimeout(650)
      }

      // このページで1件も取れなければ末尾
      if (pageSeen.size === 0) {
        if (!metaSent) await onPage([], { total })
        break
      }

      const meta = metaSent ? {} : { total }
      metaSent = true
      const cont = await onPage(pageJobs, meta)
      if (cont === false) break
    }
  },

  // 現在DOM上に見えている求人カードを読み取る
  async readVisibleCards(page) {
    return await page.$$eval('[data-testid="job-search-result-card"]', (cards) =>
      cards.map((card) => {
        const titleLink = card.querySelector('a[href^="/search/"]')
        const href = titleLink?.getAttribute('href') || ''
        const idMatch = href.match(/\/search\/(\d+)/)
        const title = (titleLink?.innerText || '').trim()
        // 企業名リンク（求人詳細以外の外部リンク）= 2番目のa
        const anchors = Array.from(card.querySelectorAll('a'))
        const companyLink = anchors.find((a) => {
          const h = a.getAttribute('href') || ''
          return !h.startsWith('/search/')
        })
        const company = (companyLink?.innerText || '').trim()
        return {
          id: idMatch ? idMatch[1] : '',
          title,
          company,
          text: card.innerText || '',
        }
      })
    )
  },

  // カードのテキストから NormalizedJob を構築（詳細ページ不要）
  cardToJob(card) {
    const lines = card.text.split('\n').map((l) => l.trim())

    const jobCategory = extractByLabel(lines, '職種')
    const salaryText = extractByLabel(lines, '年収')
    const locationText = extractByLabel(lines, '勤務地')

    // 応募資格（「応募資格」ラベル→次見出しまで）
    const requirements = extractByLabel(lines, '応募資格', [
      '仕事内容',
      '選考通過者の現年収分布',
      '書類選考スピード',
    ])
    // 仕事内容
    let description = extractByLabel(lines, '仕事内容', [
      '応募資格',
      '企業情報',
      'この求人の魅力',
    ])
    if (!description) {
      // タイトル直後の紹介文（カード冒頭のリード文）を代替に使う
      description = card.text.slice(0, 400)
    }

    // 雇用形態
    let employment = ''
    for (const kw of ['正社員', '契約社員', '業務委託', 'アルバイト', 'パート', '派遣', '紹介予定派遣']) {
      if (card.text.includes(kw)) {
        employment = kw
        break
      }
    }

    // 業種: 企業名直後のカッコ内（「（ハウスメーカー…、建設…）」）
    let industry = ''
    const indMatch = card.text.match(/[（(]([^（）()]*(?:メーカー|建設|不動産|サービス|商社|金融|医療|介護|IT|通信|小売|流通|製造|運輸|飲食|コンサル)[^（）()]*)[)）]/)
    if (indMatch) industry = indMatch[1].trim()

    const { min, max } = parseSalary(salaryText)
    const locations = parseLocations(locationText)

    return {
      source: 'circus',
      sourceJobId: card.id,
      title: card.title || jobCategory || `求人${card.id}`,
      company: card.company || '',
      jobCategory,
      industry,
      employment,
      locations,
      salaryMin: min,
      salaryMax: max,
      overtime: '',
      holiday: '',
      benefits: '',
      requirements,
      description: (description || '').slice(0, 1500),
      url: `${this.base}/search/${card.id}`,
      isOpen: true, // /search は公開中求人のみが対象
    }
  },

  // ------------------------------------------------------------
  // 機能B: 詳細ページ取得
  // 詳細ページ /search/{id} を開いて「選定の鍵」となる構造化情報を抽出する。
  // 検索結果カードには載っていない採用要件（年齢/性別/学歴 等）が取れる。
  // コスト管理のため、粗選別を通過した上位候補にのみ呼び出す想定。
  //
  // 実測で判明した構造:
  //  ・th/td 表: 勤務地・勤務時間 / 給与・年収例 / 仕事内容 / 休日休暇・福利厚生 等
  //  ・「採用要件」ブロック: 応募必須条件に
  //      「22歳~50歳」(年齢) / 「性別不問」(性別) / 「高卒以上」(学歴) /
  //      「職種未経験OK」「業種未経験OK」(未経験可) が縦に並ぶ
  //  ・「■必須要件：」以下に自由記述の必須条件
  //  ・「内定の可能性が高い人」ブロック
  // ------------------------------------------------------------
  async fetchDetail(page, sourceJobId) {
    const url = `${this.base}/search/${sourceJobId}`
    await page.goto(url, { waitUntil: 'networkidle', timeout: 45000 })
    await page.waitForTimeout(2500)
    // SPA描画のためスクロールで全要素をレンダリング
    for (let i = 0; i < 8; i++) {
      await page.mouse.wheel(0, 1500)
      await page.waitForTimeout(350)
    }
    await page.waitForTimeout(800)

    // th/td 表を辞書として収集
    const rows = await page
      .$$eval('tr', (els) =>
        els
          .map((tr) => {
            const th = tr.querySelector('th')
            const td = tr.querySelector('td')
            if (!th || !td) return null
            return [th.innerText.trim(), td.innerText.trim()]
          })
          .filter(Boolean)
      )
      .catch(() => [])
    const table = {}
    for (const [k, v] of rows) if (k && !(k in table)) table[k] = v

    const body = await page.innerText('body').catch(() => '')
    return this.parseDetail(sourceJobId, table, body)
  },

  // fetchDetail が集めた table/body から構造化フィールドを取り出す（テスト容易化のため分離）
  parseDetail(sourceJobId, table, body) {
    const pick = (...keys) => {
      for (const k of keys) {
        for (const tk of Object.keys(table)) {
          if (tk.includes(k)) return table[tk]
        }
      }
      return ''
    }

    // 「採用要件 / 応募必須条件」ブロックを本文から切り出す（HIGH優先度情報の宝庫）
    // 例: "採用要件\n応募必須条件...\n22歳~50歳\n性別不問\n外国籍NG\n高卒以上\n職種未経験OK\n業種未経験OK\n■必須要件：..."
    let requirementBlock = ''
    const ai = body.indexOf('応募必須条件')
    if (ai >= 0) {
      // 「■必須要件」or「内定の可能性が高い人」or 2000字先までを終端に
      const rest = body.slice(ai)
      const endIdx = Math.min(
        ...['内定の可能性が高い人', 'エージェント向け情報']
          .map((s) => rest.indexOf(s))
          .filter((i) => i > 0)
          .concat([2000])
      )
      requirementBlock = rest.slice(0, endIdx).trim()
    }

    // --- HIGH 優先度（揺るぎない情報）---
    // 年齢制限: 「22歳~50歳」「22歳～50歳」等
    let ageMin = null, ageMax = null, ageText = ''
    const am = requirementBlock.match(/(\d{2})\s*歳\s*[~〜～\-ー]\s*(\d{2})\s*歳/)
    if (am) { ageMin = parseInt(am[1], 10); ageMax = parseInt(am[2], 10); ageText = am[0] }
    else {
      const am2 = requirementBlock.match(/(\d{2})\s*歳\s*(以下|まで|未満)/)
      if (am2) { ageMax = parseInt(am2[1], 10); ageText = am2[0] }
      const am3 = requirementBlock.match(/(\d{2})\s*歳\s*(以上)/)
      if (am3) { ageMin = parseInt(am3[1], 10); ageText = (ageText ? ageText + ' ' : '') + am3[0] }
    }

    // 性別: 性別不問 / 男性のみ / 女性のみ
    let gender = ''
    if (requirementBlock.includes('性別不問') || body.includes('性別不問')) gender = '不問'
    else if (/女性(のみ|活躍|歓迎)/.test(requirementBlock)) gender = '女性'
    else if (/男性(のみ|活躍|歓迎)/.test(requirementBlock)) gender = '男性'

    // 学歴: 高卒以上 / 大卒以上 / 学歴不問 等（最初に一致したもの）
    let education = ''
    for (const e of ['学歴不問', '中卒以上', '高卒以上', '専門卒以上', '短大卒以上', '高専卒以上', '大卒以上', '大学院卒']) {
      if (requirementBlock.includes(e) || body.includes(e)) { education = e; break }
    }

    // 国籍
    let nationality = ''
    if (requirementBlock.includes('外国籍NG') || body.includes('外国籍NG')) nationality = '外国籍NG'
    else if (requirementBlock.includes('外国籍OK') || requirementBlock.includes('外国籍可')) nationality = '外国籍OK'

    // 勤務地（th/td「勤務地」を優先。無ければ「勤務地・勤務時間」）
    const locationText = pick('勤務地')
    const locations = parseLocations(locationText)

    // 給与・年収（長文の場合は「想定年収」行を優先して短く）
    const salaryRaw = pick('年収', '給与・年収例', '月給')
    const { min: salaryMin, max: salaryMax } = parseSalary(salaryRaw)
    let salaryText = salaryRaw
    const sm = salaryRaw.match(/想定年収[：: ]*[^\n]+/)
    if (sm) salaryText = sm[0].replace(/想定年収[：: ]*/, '').trim()

    // --- LOW 優先度（不正確な場合が多い）---
    const jobCategory = pick('職種')
    const uncertainTags = []
    for (const t of ['職種未経験OK', '職種未経験可', '業種未経験OK', '業種未経験可', '未経験OK', '未経験可']) {
      if (requirementBlock.includes(t) || body.includes(t)) uncertainTags.push(t)
    }

    // 必須要件（自由記述）
    let mustText = ''
    const mi = body.indexOf('■必須要件')
    if (mi >= 0) mustText = body.slice(mi, mi + 500).trim()

    return {
      sourceJobId,
      detail: {
        // HIGH（揺るぎない）
        ageMin, ageMax, ageText,
        gender,
        education,
        nationality,
        locations,
        locationText: (locationText || '').slice(0, 500),
        salaryMin, salaryMax, salaryText: (salaryText || '').slice(0, 300),
        // 自由記述の必須条件
        mustRequirements: mustText,
        requirementBlock: requirementBlock.slice(0, 1200),
        // LOW（不正確・参考程度）
        jobCategory,
        uncertainTags,
        // 参考: 仕事内容・PR等の長文
        jobContent: (pick('仕事内容') || '').slice(0, 2000),
        prPoint: (pick('PRポイント', 'PR') || '').slice(0, 800),
        holiday: (pick('休日休暇') || '').slice(0, 500),
        business: (pick('事業内容') || '').slice(0, 500),
      },
    }
  },

  // ------------------------------------------------------------
  // 機能A: AIが組み立てた検索プランをUI操作で適用して件数を取得する。
  //
  // 「詳しい条件」の絞り込み(年齢/性別/学歴/年収/雇用形態/残業/各種チェック)は
  // URLに載らずJS state管理のため、Playwrightでフォーム操作→検索ボタン押下が必須。
  //
  // plan の形（全て任意。指定された項目だけ設定する）:
  // {
  //   keyword: '営業',               // キーワード（qJson[1].keyword=OR に入れる）
  //   keywordField: 8,               // 検索対象フィールド option番号（既定8=全文）
  //   age: 30,                       // 求職者の年齢
  //   gender: '男性',                // requiredGenders
  //   education: '大卒',             // education
  //   salaryMin: 400,                // annualSalary.min（万円）
  //   salaryMax: 800,
  //   overtime: '30時間以下',        // averageOvertimes
  //   checks: { employment:['正社員'], workEnv:['リモートワークOK'], ... }, // チェック群
  // }
  // 戻り値: { total, appliedUrl }  total=絞り込み後の総件数
  // ------------------------------------------------------------
  // React制御コンポーネント(input/select)へ、ネイティブsetter+input/changeイベントで
  // 値を確実に反映する。page.fill だけでは React state に伝わらず、絞り込み件数
  // プレビューが更新されないケースがあるため。
  async _setReactValue(page, selector, value) {
    return await page.evaluate(({ sel, val }) => {
      const el = document.querySelector(sel)
      if (!el) return false
      const proto = el.tagName === 'SELECT'
        ? window.HTMLSelectElement.prototype
        : window.HTMLInputElement.prototype
      const desc = Object.getOwnPropertyDescriptor(proto, 'value')
      if (desc && desc.set) desc.set.call(el, String(val))
      else el.value = String(val)
      el.dispatchEvent(new Event('input', { bubbles: true }))
      el.dispatchEvent(new Event('change', { bubbles: true }))
      el.dispatchEvent(new Event('blur', { bubbles: true }))
      return true
    }, { sel: selector, val: value }).catch(() => false)
  },

  async applyConditions(page, plan = {}) {
    const field = plan.keywordField || parseInt(process.env.CIRCUS_SEARCH_OPTION || '8', 10)
    // まずキーワードだけURLで投入した状態から開始（qJsonにキーワードを載せておく）
    const baseUrl = this.buildSearchUrl(
      { keyword: plan.keyword || '', freeText: '' },
      1
    ).replace(/"option":\d+/g, `"option":${field}`)
    await page.goto(baseUrl, { waitUntil: 'networkidle', timeout: 60000 })
    await page.waitForTimeout(2500)

    // 「さらに詳しい条件で検索する」を開く。開くと select[name=education] 等が
    // DOMに現れるので、その出現を明示的に待つ（クリックの不安定さ対策）。
    const alreadyOpen = await page.$('select[name="education"]')
    if (!alreadyOpen) {
      const openBtn = page.getByText('さらに詳しい条件').first()
      if (await openBtn.count()) {
        await openBtn.click().catch(() => {})
      }
      // education select が出るまで最大10秒待つ
      await page.waitForSelector('select[name="education"]', { timeout: 10000 }).catch(() => {})
      await page.waitForTimeout(1000)
    }

    // --- select群（性別・学歴・残業）: React setter で確実に ---
    if (plan.gender && CIRCUS_COND.selects.gender.options.includes(plan.gender)) {
      await this._setReactValue(page, `select[name="${CIRCUS_COND.selects.gender.name}"]`, plan.gender)
      await page.waitForTimeout(400)
    }
    if (plan.education && CIRCUS_COND.selects.education.options.includes(plan.education)) {
      await this._setReactValue(page, `select[name="${CIRCUS_COND.selects.education.name}"]`, plan.education)
      await page.waitForTimeout(400)
    }
    if (plan.overtime && CIRCUS_COND.selects.overtime.options.includes(plan.overtime)) {
      await this._setReactValue(page, `select[name="${CIRCUS_COND.selects.overtime.name}"]`, plan.overtime)
      await page.waitForTimeout(400)
    }

    // --- input群（年齢・年収）: React setter で確実に ---
    // 年収は「annualSalary.include（=この年収以上を含む）」が主入力。plan.salaryMin を
    // ここへ入れる。min/max の範囲指定が来た場合は従来の text 入力へ。
    if (plan.age != null) {
      await this._setReactValue(page, `input[name="${CIRCUS_COND.inputs.age}"]`, plan.age)
      await page.waitForTimeout(400)
    }
    if (plan.salaryMin != null && plan.salaryMax == null) {
      await this._setReactValue(page, `input[name="${CIRCUS_COND.inputs.salaryInclude}"]`, plan.salaryMin)
      await page.waitForTimeout(400)
    } else {
      if (plan.salaryMin != null) {
        await this._setReactValue(page, `input[name="${CIRCUS_COND.inputs.salaryMin}"]`, plan.salaryMin)
        await page.waitForTimeout(400)
      }
      if (plan.salaryMax != null) {
        await this._setReactValue(page, `input[name="${CIRCUS_COND.inputs.salaryMax}"]`, plan.salaryMax)
        await page.waitForTimeout(400)
      }
    }

    // --- チェックボックス群 ---
    if (plan.checks && typeof plan.checks === 'object') {
      for (const [cat, labels] of Object.entries(plan.checks)) {
        const valid = CIRCUS_COND.checkboxes[cat]
        if (!valid || !Array.isArray(labels)) continue
        for (const label of labels) {
          if (!valid.includes(label)) continue
          const cb = page.getByText(label, { exact: true }).first()
          if (await cb.count()) {
            await cb.click().catch(() => {})
            await page.waitForTimeout(200)
          }
        }
      }
    }
    await page.waitForTimeout(800)

    // 検索実行ボタン。circusのボタンは「条件に合う求人{N}件を検索する」という
    // 動的テキスト。件数プレビューがボタンに埋まっているので、まずこのボタンの
    // 件数が安定するまで待ってから押す。
    const btnRe = /条件に合う求人\s*([\d,]+)\s*件を検索する/
    const findBtn = () => page.getByText(/条件に合う求人.*件を検索する/).first()

    // ボタンのプレビュー件数が安定するまで待つ（フォーム反映のデバウンス対策）
    let preview = null
    let prevPrev = null
    for (let i = 0; i < 10; i++) {
      const txt = await findBtn().textContent().catch(() => '')
      const m = txt && txt.match(btnRe)
      const n = m ? parseInt(m[1].replace(/,/g, ''), 10) : null
      if (n != null) {
        if (n === prevPrev) { preview = n; break }
        prevPrev = n
        preview = n
      }
      await page.waitForTimeout(800)
    }

    // ボタンをクリックして検索確定
    const searchBtn = findBtn()
    if (await searchBtn.count()) {
      await searchBtn.scrollIntoViewIfNeeded().catch(() => {})
      await searchBtn.click().catch(() => {})
    }
    await page.waitForTimeout(3500)

    // 検索結果一覧の総件数が安定するまで待つ（プレビューと一致するはず）。
    let total = null
    let prev = null
    let stable = 0
    for (let i = 0; i < 10; i++) {
      const t = await this.readTotalCount(page)
      if (t != null) {
        if (t === prev) { stable++; if (t > 0 && stable >= 1) { total = t; break } }
        else { stable = 0 }
        prev = t
        total = t
      }
      await page.waitForTimeout(1000)
    }
    // 結果一覧が0でプレビューが正の場合はプレビュー件数を採用（描画遅延対策）
    if ((total == null || total === 0) && preview != null) total = preview
    return { total, preview, appliedUrl: page.url() }
  },

  // 機能A: プラン適用後の絞り込み状態から、ページネーションで求人を取得する。
  // applyConditions を呼んだ後の page をそのまま渡す。onPage は fetchJobsPaged と同じ契約。
  // 絞り込み状態(JS state)を保つため、goto せず「次へ」ページ送り or page= URL 変更で辿る。
  async fetchJobsAfterConditions(page, onPage, opts = {}) {
    const PAGE_SIZE = 25
    const maxPages = opts.maxPages || 200
    const appliedUrl = page.url()
    const globalSeen = new Set()
    let total = null
    let metaSent = false

    for (let pageNo = 1; pageNo <= maxPages; pageNo++) {
      if (pageNo > 1) {
        // 絞り込み状態を保ったままページ送り: URLの page= だけ差し替えて遷移
        const nextUrl = appliedUrl.replace(/([?&]page=)\d+/, `$1${pageNo}`)
        // page= が無い場合は付与
        const url2 = /[?&]page=/.test(nextUrl) ? nextUrl : `${nextUrl}&page=${pageNo}`
        await page.goto(url2, { waitUntil: 'networkidle', timeout: 60000 })
        await page.waitForTimeout(2000)
      }
      const { total: pageTotal, ok } = await this.waitForResults(page)
      if (total == null) { total = pageTotal; console.log(`[circus] 絞込後 総件数=${total} 件`) }
      if (!ok) { if (!metaSent) await onPage([], { total }); break }

      const pageJobs = []
      const pageSeen = new Set()
      let stagnant = 0
      for (let step = 0; step < 50; step++) {
        const cards = await this.readVisibleCards(page)
        let fresh = 0
        for (const card of cards) {
          if (!card.id || pageSeen.has(card.id)) continue
          pageSeen.add(card.id); fresh++
          if (globalSeen.has(card.id)) continue
          globalSeen.add(card.id)
          try { const job = this.cardToJob(card); if (job) pageJobs.push(job) } catch {}
        }
        if (fresh === 0) stagnant++; else stagnant = 0
        if (stagnant >= 8 || pageSeen.size >= PAGE_SIZE) break
        await page.mouse.wheel(0, 1200)
        await page.waitForTimeout(650)
      }
      if (pageSeen.size === 0) { if (!metaSent) await onPage([], { total }); break }
      const meta = metaSent ? {} : { total }
      metaSent = true
      const cont = await onPage(pageJobs, meta)
      if (cont === false) break
    }
  },
}

// ------------------------------------------------------------
// ②ヒトリンク (未調査 — 次に構造確認)
// ------------------------------------------------------------
export const hitolinkAdapter = {
  source: 'hitolink',
  base: 'https://agent.hito-link.jp',
  async login(page, env) {
    await page.goto(env.HITOLINK_LOGIN_URL, { waitUntil: 'networkidle', timeout: 45000 })
    throw new Error('hitolinkAdapter.login は未実装です（画面構造の確認が必要）。')
  },
  async fetchJobs(page, criteria, onJob) {
    return
  },
}

// ------------------------------------------------------------
// ③ジョビンズ (未調査 — 403対策でPlaywright必須)
// ------------------------------------------------------------
export const jobinsAdapter = {
  source: 'jobins',
  base: 'https://jobins.jp',
  async login(page, env) {
    await page.goto(env.JOBINS_LOGIN_URL, { waitUntil: 'networkidle', timeout: 45000 })
    throw new Error('jobinsAdapter.login は未実装です（画面構造の確認が必要）。')
  },
  async fetchJobs(page, criteria, onJob) {
    return
  },
}

export const ADAPTERS = {
  circus: circusAdapter,
  hitolink: hitolinkAdapter,
  jobins: jobinsAdapter,
}
