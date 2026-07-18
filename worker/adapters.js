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

    // ★ circus 実データで確定したフィールド（probe_reward.js / probe_reward2.js で300件検証済）:
    //   raw.commissionFee = { id, fee }
    //   fee は「率(%)」と「固定額(円)」の2種類が同じフィールドに混在する。
    //   種別フィールドは存在しないが、実データの値分布が明確に2群に分かれる:
    //     ・率型   : fee = 25〜60         → 理論年収 × fee%     （例 fee:45 → 理論年収×45%）
    //     ・固定額 : fee = 500,000〜2,500,000（円） → 一律 fee円  （例 fee:600000 → 一律60万円）
    //   60 と 500000 の間は完全に空白のため、しきい値で誤判定なく区別できる。
    //   判定: fee <= 1000 は率(%)、fee >= 10000 は固定額(円)。
    //   （id はプランIDで報酬額ではないので使わない）
    if (raw.commissionFee && typeof raw.commissionFee === 'object' && raw.commissionFee.fee != null) {
      const f = typeof raw.commissionFee.fee === 'number'
        ? raw.commissionFee.fee
        : parseFloat(String(raw.commissionFee.fee).replace(/[, ]/g, ''))
      if (Number.isFinite(f) && f > 0) {
        if (f <= 1000) {
          // 率(%)として扱う（実データ上は 25〜60 の範囲）
          return { type: 'rate', rate: f, amount: null, text: '' }
        }
        // 固定額（円）として扱う（実データ上は 50万〜250万円）
        return { type: 'fixed', rate: null, amount: f, text: '' }
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
// ②ヒトリンク (HITO-Link エージェント) — API直接方式（実装済み）
//   circus と同じ「Playwrightでログイン → 認証情報キャプチャ → 内部APIを叩く」
//   方式。ただし circus との差異が2点ある（調査レポート 2026-07-17 実証済）:
//     1. ログインは Azure AD B2C(OAuth2/OIDC)経由（メール+PWのみ、2FA/CAPTCHA無し）
//     2. 認証キャリアは httpOnly の `SESSION` Cookie（抜き出せるBearerトークンは無い）
//     3. APIは独立RESTではなく Next.js Server Action 経由:
//        すべて POST /manage/matter に対して、バックエンドAPIパスを
//        POSTボディ第1引数で指定する RSC(flight) プロトコル。
//
//   ★ index.js の processSource は circus と同じインターフェース
//     (getAuthToken/buildQJson/apiCount/apiSearch/mapApiJob/extractKeyword)
//     を要求するため、hitolink もそれに合わせる。circus では token=UUID文字列
//     だが、hitolink では token = { sessionCookie, nextAction } オブジェクトを
//     そのまま流用する（processSource は token を不透明値として渡すだけなので問題ない）。
//
//   検索: POST /manage/matter
//         body=["/matter/query/search-matter?pageNo=N&pageSize=M&sortType=0",
//               {"method":"POST","body":"<検索条件JSON文字列>"}]
//         → RSC flight の "ok":true 行の data.matters(配列) + data.totalCount
//   件数: 専用APIは無い。search-matter を pageSize=1 で叩き data.totalCount を読む。
// ------------------------------------------------------------

// 検索条件ボディの既定値（省略不可フィールドが多い。欠けると 500 JSON parse error）
const HITOLINK_SEARCH_DEFAULTS = {
  keywords: [],
  matterTypes: [], prefectures: [],
  annualIncomeIncluded: 0, annualIncomeMin: 0, annualIncomeMax: 0, age: 0,
  occupations: [], amount: 0, rate: 0, jobType: '', academicBackgrounds: [],
  businessTypes: [],
  noExperienceNecessary: false, noIndustryExperienceNecessary: false,
  dayOffWeekendsHolidays: false, isFlexibleWorkType: false, salaryType: '',
  isBookmarked: false, workHistoryFrom: 0, workHistoryTo: 0,
  isNoFullTimeExperience: false, isPublicCompany: false,
  hasMoreThan120DaysOff: false, isSideJobOk: false, changeJobCountType: '',
  isForeignNationalOk: false, isRemoteOk: false, isNoRelocation: false,
  isOvertimeUnder20h: false, hasMaternityPaternityLeave: false,
  isReducedHoursOk: false, isServiceB2c: false, isServiceB2b: false,
  hasHousingAllowance: false, isDressCodeCasual: false, isCarCommutingOk: false,
  hasRetirementSystem: false, suggestionMatterGroupId: '', candidateId: '',
  isRecruitmentDocSelectionPassRateOver50: false,
  isRecruitmentSelectionLeadTimeFinalWithin2weeks: false,
  isRecruitmentHiringQuotaOver10: false,
}

// 調査時にキャプチャした next-router-state-tree（Server Action呼び出しに必須）。
// next-action ID はビルドで変わり得るためログイン時に動的キャプチャするが、
// これは固定文字列で動作することを実証済み。
const HITOLINK_ROUTER_TREE =
  '%5B%22%22%2C%7B%22children%22%3A%5B%22manage%22%2C%7B%22children%22%3A%5B%22matter%22%2C%7B%22children%22%3A%5B%22__PAGE__%22%2C%7B%7D%2Cnull%2Cnull%2C0%5D%7D%2Cnull%2Cnull%2C0%5D%7D%2Cnull%2Cnull%2C0%5D%7D%2Cnull%2Cnull%2C16%5D'
// フォールバック用の next-action ID（動的キャプチャ失敗時に使用）
const HITOLINK_FALLBACK_ACTION = '600e94cf457c70cf338da8f3667cac8f1b06b29bc5'

export const hitolinkAdapter = {
  source: 'hitolink',
  base: 'https://agent.hito-link.jp',

  // ---- ログイン（Azure AD B2C 経由）----
  //   /login の「ログイン」リンク→B2Cフォームへ遷移→メール/PW入力→送信。
  //   ★ハイドレーション完了前にsubmitすると失敗するため #email 出現後に待機必須。
  async login(page, env) {
    const loginUrl = env.HITOLINK_LOGIN_URL || 'https://agent.hito-link.jp/login'
    const email = env.HITOLINK_ID || env.HITOLINK_EMAIL
    const pw = env.HITOLINK_PW || env.HITOLINK_PASSWORD
    if (!email || !pw) throw new Error('hitolink 認証情報(HITOLINK_ID / HITOLINK_PW)が未設定です')

    await page.goto(loginUrl, { waitUntil: 'domcontentloaded', timeout: 45000 })
    await page.waitForTimeout(1500)

    // 既にログイン済み（/manage 配下に居る）ならスキップ
    if (/agent\.hito-link\.jp\/manage/.test(page.url())) return

    // /login 上の OAuth 開始リンクをクリックして B2C へ
    const startLink = await page.$('a[href*="oauth2/authorization"]')
    if (startLink) {
      await startLink.click()
    } else if (!/b2clogin|agent-login\.hito-link/.test(page.url())) {
      // リンクが無く B2C 画面でもない場合は直接 authorization エンドポイントへ
      await page.goto(`${this.base}/oauth2/authorization/agt`, { waitUntil: 'domcontentloaded', timeout: 45000 })
    }

    // B2C ログインフォーム（#email / #password / #next）
    await page.waitForSelector('#email', { timeout: 20000 })
    await page.waitForTimeout(1500) // ← ハイドレーション待ち（必須）
    await page.fill('#email', email)
    await page.fill('#password', pw)
    await page.click('#next')

    // ログイン完了 = /manage 配下へ遷移
    await page.waitForURL(/agent\.hito-link\.jp\/manage/, { timeout: 40000 }).catch(() => {})
    if (!/agent\.hito-link\.jp\/manage/.test(page.url())) {
      const body = await page.innerText('body').catch(() => '')
      if (page.url().includes('error') || body.includes('ログインに失敗')) {
        throw new Error('hitolink ログイン失敗（認証情報またはB2Cハイドレーション待ちを確認）')
      }
    }
  },

  // ---- 認証情報の取得 ----
  //   circus の getAuthToken(トークン文字列)に相当。hitolink では
  //   SESSION Cookie + next-action ID をまとめて返す（processSource は
  //   この戻り値を不透明な token として apiCount/apiSearch に渡すだけ）。
  //   /manage/matter を開いて next-action ID を動的キャプチャする（堅牢性）。
  async getAuthToken(page) {
    let nextAction = null
    const handler = (r) => {
      const h = r.headers()
      if (h['next-action'] && !nextAction) nextAction = h['next-action']
    }
    page.on('request', handler)
    try {
      await page.goto(`${this.base}/manage/matter`, { waitUntil: 'networkidle', timeout: 60000 })
      for (let t = 0; t < 12 && !nextAction; t++) await page.waitForTimeout(600)
    } finally {
      page.off('request', handler)
    }

    // SESSION Cookie を取得
    const cookies = await page.context().cookies()
    const sess = cookies.find((c) => c.name === 'SESSION' && (c.domain || '').includes('agent.hito-link.jp'))
    if (!sess) throw new Error('hitolink SESSION Cookie の取得に失敗しました')

    return {
      sessionCookie: `SESSION=${sess.value}`,
      nextAction: nextAction || HITOLINK_FALLBACK_ACTION,
    }
  },

  // ---- 検索条件オブジェクトの組み立て ----
  //   circus の buildQJson(4要素配列)に相当。hitolink では
  //   HITOLINK_SEARCH_DEFAULTS に keywords/絞り込みをマージした
  //   検索条件オブジェクトを返す（apiCall で JSON文字列化する）。
  //   terms.or（スペース区切りキーワード）を「求人情報(matter)」全文検索へ。
  //   複数語は keywords 配列に複数入れると AND 条件になるため、
  //   OR網羅重視で "最初の1語のみ" を使う（circusのor思想に合わせる）。
  buildQJson(terms = {}, filters = {}) {
    const body = { ...HITOLINK_SEARCH_DEFAULTS }
    const raw = (terms.or || terms.and || '').trim()
    if (raw) {
      // スペース区切りの先頭語を全文検索キーワードに（AND化を避け網羅重視）
      const first = raw.split(/[\s　]+/).filter(Boolean)[0]
      if (first) {
        body.keywords = [{ searchType: 'matter', searchMode: 'match', keyword: first }]
      }
    }
    // 追加絞り込み（将来拡張。circus数値コードは使わず hitolink 固有キーのみ）
    if (filters && typeof filters === 'object') {
      if (Array.isArray(filters.prefectures) && filters.prefectures.length) body.prefectures = filters.prefectures
      if (filters.annualIncomeMin) { body.annualIncomeMin = filters.annualIncomeMin; body.annualIncomeIncluded = 1 }
      if (filters.annualIncomeMax) { body.annualIncomeMax = filters.annualIncomeMax; body.annualIncomeIncluded = 1 }
      if (filters.jobType) body.jobType = filters.jobType
    }
    return body
  },

  // ---- Server Action 経由の内部API呼び出し（共通処理）----
  //   token = { sessionCookie, nextAction }
  //   ブラウザコンテキスト内 fetch で POST /manage/matter を叩き、
  //   RSC flight（text/x-component）を返す。パースは _parseFlight で行う。
  async _actionCall(page, token, actionArgs) {
    const { sessionCookie, nextAction } = token || {}
    const res = await page.evaluate(async ({ base, nextAction, routerTree, actionArgs }) => {
      const r = await fetch(`${base}/manage/matter`, {
        method: 'POST',
        credentials: 'include',
        headers: {
          'content-type': 'text/plain;charset=UTF-8',
          'accept': 'text/x-component',
          'next-action': nextAction,
          'next-router-state-tree': routerTree,
        },
        body: JSON.stringify(actionArgs),
      })
      const text = await r.text()
      return { status: r.status, text }
    }, { base: this.base, nextAction, routerTree: HITOLINK_ROUTER_TREE, actionArgs })
    return res
  },

  // RSC flight（改行区切りの id:payload）をパースする。
  //   Next.js の Server Action レスポンスは「flight」形式:
  //     0:{...}                  ← メタ行
  //     2:T<hexlen>,<本文…>      ← 長い文字列は別チャンクに切り出され、
  //     <本文の続き…>            ← 改行を含む場合は次のトップレベルid行まで続く
  //     1:{"ok":true,"data":{... "summary":"$2" ...}}  ← 本体（$N は id=N への参照）
  //   よって: (1)各トップレベルチャンク(id→raw値)を集める → (2)"ok"を含む本体JSONを
  //   見つけて JSON.parse → (3)"$N" 参照文字列をチャンク本文で解決する。
  _parseFlight(text) {
    if (!text) return null
    const lines = text.split('\n')

    // (1) トップレベルチャンクを分解。`^<id>:<rest>` で始まる行が新チャンクの開始。
    //     続く行（idプレフィックス無し）は直前チャンクの本文の一部（改行込み）。
    const chunks = {}            // id(string) → 生rest文字列（複数行は \n で連結）
    let curId = null
    const idRe = /^([0-9a-f]+):([\s\S]*)$/
    for (const line of lines) {
      const m = line.match(idRe)
      if (m) {
        curId = m[1]
        chunks[curId] = m[2]
      } else if (curId != null) {
        chunks[curId] += '\n' + line
      }
    }

    // チャンク値を「解決済み文字列」に整える。
    //   T<hexlen>,<本文> 形式なら "," 以降が本文。それ以外はそのまま。
    const resolveChunkText = (rest) => {
      if (rest == null) return ''
      const tm = rest.match(/^T[0-9a-f]+,([\s\S]*)$/)
      if (tm) return tm[1]
      return rest
    }

    // (2) 本体JSON（"ok" を含む { ... } チャンク）を探す
    let body = null
    for (const [, rest] of Object.entries(chunks)) {
      const s = (rest || '').trimStart()
      if (s.startsWith('{') && s.includes('"ok"') && s.includes('"data"')) {
        try { body = JSON.parse(s) } catch { /* 次へ */ }
        if (body) break
      }
    }
    if (!body || !body.data) return null

    // (3) "$N" 参照を解決（オブジェクトを再帰的に走査し、"$数字" 文字列を差し替え）
    const refRe = /^\$([0-9a-f]+)$/
    const seen = new WeakSet()
    const resolve = (v) => {
      if (typeof v === 'string') {
        const rm = v.match(refRe)
        if (rm && chunks[rm[1]] != null) return resolveChunkText(chunks[rm[1]])
        return v
      }
      if (Array.isArray(v)) return v.map(resolve)
      if (v && typeof v === 'object') {
        if (seen.has(v)) return v
        seen.add(v)
        for (const k of Object.keys(v)) v[k] = resolve(v[k])
        return v
      }
      return v
    }
    body.data = resolve(body.data)
    return body
  },

  // 求人検索（本体）。params = { qJson(=検索条件obj), filters, limit, offset, pageNo }
  // 戻り値: { total, jobs:[生matter], status }
  //
  // ★リトライ付き: hitolink サーバは連続アクセス時に一時的な失敗(空/エラー/ok!=true)を
  //   返すことがある（特に circus と並列で走らせると顕著）。指数バックオフで最大3回試す。
  async apiSearch(page, token, params = {}) {
    const { qJson, filters, limit = 100, offset = 0, pageNo } = params
    const pno = pageNo || Math.floor(offset / (limit || 100)) + 1
    const body = qJson || this.buildQJson({}, filters)
    const actionArgs = [
      `/matter/query/search-matter?pageNo=${pno}&pageSize=${limit}&sortType=0`,
      { method: 'POST', body: JSON.stringify(body) },
    ]

    const MAX_TRY = 3
    let lastErr = null
    for (let attempt = 1; attempt <= MAX_TRY; attempt++) {
      let status = 0
      let text = ''
      try {
        const r = await this._actionCall(page, token, actionArgs)
        status = r.status
        text = r.text
      } catch (e) {
        lastErr = new Error(`hitolink apiSearch 通信失敗: ${e.message}`)
      }

      if (status === 200 && !lastErr) {
        const obj = this._parseFlight(text)
        if (obj && obj.ok === true) {
          const data = obj.data || {}
          return {
            total: typeof data.totalCount === 'number' ? data.totalCount : null,
            jobs: Array.isArray(data.matters) ? data.matters : [],
            status,
          }
        }
        // パース失敗 / ok!=true。デバッグのため先頭を残す（PIIを避け先頭300字のみ）。
        const head = (text || '').replace(/\s+/g, ' ').slice(0, 300)
        lastErr = new Error(`hitolink apiSearch: flightパース失敗またはok=false (len=${(text || '').length}, head="${head}")`)
      } else if (!lastErr) {
        const head = (text || '').replace(/\s+/g, ' ').slice(0, 200)
        lastErr = new Error(`hitolink apiSearch 失敗 status=${status} head="${head}"`)
      }

      // 最終試行でなければバックオフして再試行
      if (attempt < MAX_TRY) {
        const wait = 800 * attempt // 800ms, 1600ms
        console.log(`[hitolink] apiSearch 一時失敗(try ${attempt}/${MAX_TRY} p${pno}) → ${wait}ms後リトライ: ${lastErr.message}`)
        await page.waitForTimeout(wait)
        lastErr = null
      }
    }
    throw lastErr || new Error('hitolink apiSearch: 不明なエラー')
  },

  // 件数のみ取得（専用APIが無いので pageSize=1 で search-matter を叩く軽量版）。
  async apiCount(page, token, params = {}) {
    try {
      const r = await this.apiSearch(page, token, { ...params, limit: 1, offset: 0, pageNo: 1 })
      return typeof r.total === 'number' ? r.total : null
    } catch (e) {
      return null
    }
  },

  // ---- 生 matter → 内部 NormalizedJob 形状へ変換（機能B）----
  //   一覧49項目から正規化。業種(businessType)は一覧に明示フィールドが無いため
  //   基本 null（詳細APIでのみ取得可能。負荷回避のため一覧段階では取らない）。
  mapApiJob(raw) {
    if (!raw) return null

    const jobCategory = raw.occupationClassification || ''
    const jobCategories = [raw.occupationClassification, raw.occupation].filter(Boolean)

    // 勤務地: prefecture + town を1件に結合
    const loc = [raw.prefecture, raw.town].filter(Boolean).join('')
    const locations = loc ? [loc] : []

    // 年収: 万円 → 円
    const salaryMin = typeof raw.annualIncomeMin === 'number' && raw.annualIncomeMin > 0
      ? Math.round(raw.annualIncomeMin * 10000) : null
    const salaryMax = typeof raw.annualIncomeMax === 'number' && raw.annualIncomeMax > 0
      ? Math.round(raw.annualIncomeMax * 10000) : null

    // 残業: isOvertimeUnder20h → テキスト
    const overtime = raw.isOvertimeUnder20h === true ? '20時間未満' : null

    // 休日: フラグからテキスト合成
    const holParts = []
    if (raw.dayOffWeekendsHolidays) holParts.push('土日祝休み')
    if (raw.hasMoreThan120DaysOff) holParts.push('年間休日120日超')
    const holiday = holParts.join('・') || null

    // 応募条件（年齢/学歴）。性別フィールドは一覧に無し→null。
    const requiredAgeMin = typeof raw.ageFrom === 'number' && raw.ageFrom > 0 ? raw.ageFrom : null
    const requiredAgeMax = typeof raw.ageTo === 'number' && raw.ageTo > 0 ? raw.ageTo : null
    const requiredGender = null
    // 学歴: "設定なし"/"不問" 等は要件なし → null
    let requiredEducation = null
    if (raw.academicBackground) {
      const ab = String(raw.academicBackground).trim()
      if (ab && !/^設定なし$|^不問$|^学歴不問$/.test(ab)) {
        requiredEducation = ab.split(',').map((s) => s.trim()).filter(Boolean).join('・')
      }
    }

    // 成果報酬: commissionType('rate'|'fixed') + commission(率% or 額)
    const reward = this._extractReward(raw)

    // 経験要件フラグ
    const experience = []
    if (raw.noExperienceNecessary) experience.push('職種未経験OK')
    if (raw.noIndustryExperienceNecessary) experience.push('業種未経験OK')
    if (raw.isNoFullTimeExperience) experience.push('正社員経験不問')
    if (raw.isForeignNationalOk) experience.push('外国籍OK')

    // 詳細URL: 一覧の recTenantId + recMatterId(6桁ゼロ埋め) から詳細画面URLを組み立て
    let url = `${this.base}/manage/matter`
    if (raw.recTenantId && raw.recMatterId != null) {
      const detailId = `${raw.recTenantId}-${String(raw.recMatterId).padStart(6, '0')}`
      url = `${this.base}/manage/matter?id=${detailId}`
    }

    return {
      source: 'hitolink',
      sourceJobId: String(raw.matterId || ''),
      title: raw.matterName || '',
      company: raw.companyName || '',
      companyWebsite: raw.companyUrl || '',
      jobCategory,
      jobCategories,
      industry: '',            // 一覧に業種名フィールド無し（詳細APIでのみ取得可）
      industries: [],
      employment: raw.jobType || '',
      locations,
      salaryMin,
      salaryMax,
      overtime,
      holiday,
      requiredAgeMin,
      requiredAgeMax,
      requiredGender,
      requiredEducation,
      reward,
      requirements: raw.essentialRequirement || '',
      description: raw.summary || '',
      url,
      isOpen: true,            // search-matter が返すのは掲載中(public)のみ
      publishStartedAt: raw.insertDateTime || null,
      lastUpdatedAt: raw.updateDateTime || null,
      _raw: raw,
    }
  },

  // 成果報酬抽出（commissionType/commission から）。
  //   type='rate' → rate(%)、type='fixed' → amount(円)。
  //   実データでは commission が rate時=25(=%), fixed時=額（万円か円かは要確認、
  //   万円想定で×10000。異常に小さい値のみ万円換算）。
  _extractReward(raw) {
    const type = raw.commissionType || 'unknown'
    const val = typeof raw.commission === 'number' ? raw.commission : null
    if (type === 'rate') {
      return { type: 'rate', rate: val, amount: null, text: val != null ? `理論年収の${val}%` : '' }
    }
    if (type === 'fixed') {
      // 固定額。100未満なら万円表記とみなし×10000、それ以上は円とみなす
      const amount = val == null ? null : (val < 1000 ? val * 10000 : val)
      return { type: 'fixed', rate: null, amount, text: val != null ? `固定 ${val}` : '' }
    }
    return { type: 'unknown', rate: null, amount: null, text: '' }
  },

  // freeText からキーワード候補を抽出（circus と同じロジック）。
  extractKeyword(criteria) {
    if (criteria.keyword && criteria.keyword.trim()) return criteria.keyword.trim()
    const ft = (criteria.freeText || '').trim()
    if (!ft) return ''
    if (Array.isArray(criteria.jobCategories) && criteria.jobCategories.length) {
      return criteria.jobCategories[0]
    }
    const KNOWN = ['営業', 'エンジニア', '事務', '経理', '人事', 'マーケティング', '企画',
      '販売', '看護', '介護', 'デザイナー', 'コンサル', '製造', '施工', '建築', '医療',
      'IT', 'プログラマ', 'ドライバー', '接客', '管理', '開発', 'データ', '財務', '総務']
    for (const k of KNOWN) if (ft.includes(k)) return k
    return ''
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

// ------------------------------------------------------------
// ④ kintone (自社DB) — REST API 直接方式（Playwright不要）
//   kintone REST API を直接叩いて求人を検索・取得する。
//   circus と同じ「API直接方式」インターフェース(getAuthToken/apiCount/
//   apiSearch/mapApiJob)を満たすので、index.js の processSource が
//   そのまま機能A(AI検索プラン反復)＋機能B(詳細=mapApiJob)を回せる。
//
//   認証:  X-Cybozu-API-Token ヘッダ（アプリ単位のAPIトークン）
//   件数:  GET /k/v1/records.json?app=&totalCount=true&query=...&fields[]=$id
//   検索:  GET /k/v1/records.json?app=&query=<cond> limit N offset M
//
//   ★ 絞り込み方針（ユーザ確定仕様）:
//     - キーワード(plan.orKeyword)を全文相当4フィールド
//       (仕事内容/求人タイトル/応募必須条件/PRポイント)に like OR で検索
//     - 勤務地(criteria.locations)は MULTI_SELECT「勤務地」を in で AND 絞り込み
//     - 公開判定: 「求人公開 in ("可能")」を常に AND 付与（=公開149件のみ対象）
//     - 職種/業種は「絞りすぎ厳禁」方針に従い、クエリでは絞らず
//       既存の機械フィルタ + AI採点に委ねる（DB規模236件なら十分）
//     - plan.filters(circus専用の数値コード)は kintone では使わない
// ------------------------------------------------------------

// kintone クエリ用に文字列をエスケープ（" を \" に）
function kintoneEscape(s) {
  return String(s == null ? '' : s).replace(/"/g, '\\"')
}

// kintone の数値文字列 → 数値（空/不正は null）
function kintoneNum(v) {
  if (v == null || v === '') return null
  const n = parseFloat(String(v).replace(/[^\d.\-]/g, ''))
  return Number.isFinite(n) ? n : null
}

export const kintoneAdapter = {
  source: 'kintone',
  get subdomain() { return process.env.KINTONE_SUBDOMAIN || 'kvln1' },
  get appId() { return process.env.KINTONE_APP_ID || '101' },
  get apiToken() { return process.env.KINTONE_API_TOKEN || '' },
  get base() { return `https://${this.subdomain}.cybozu.com` },

  // 全文相当フィールド（キーワードOR検索対象）。ユーザ確定仕様。
  KEYWORD_FIELDS: ['仕事内容', '求人タイトル', '応募必須条件', 'PRポイント'],

  // Playwright不要。processSource は login→getAuthToken の順に呼ぶが
  // kintone はページ操作不要なので何もしない（page引数は無視）。
  async login(_page, _env) { /* no-op: REST APIトークン認証 */ },

  // circus の getAuthToken 相当。kintone はAPIトークンをヘッダで送るだけなので
  // トークン文字列をそのまま返す（processSource が token として保持）。
  async getAuthToken(_page) {
    const t = this.apiToken
    if (!t) throw new Error('KINTONE_API_TOKEN が未設定です')
    return t
  },

  // circus の buildQJson 相当。ここでは「キーワード条件」を表す構造を返すだけ。
  //   terms.or : スペース区切りキーワード（plan.orKeyword）
  // 戻り値はこのアダプタ内部の apiCount/apiSearch でだけ解釈する不透明オブジェクト。
  buildQJson(terms = {}) {
    const kw = String(terms.or || '').trim()
    // スペース/全角スペースで分割した語（空語除去、最大8語）
    const words = kw.split(/[\s\u3000]+/).map((w) => w.trim()).filter(Boolean).slice(0, 8)
    return { words }
  },

  // qJson(=buildQJshの戻り) → kintone クエリ文字列（order/limit/offset除く）。
  //   ・公開判定「求人公開=可能」を常に AND 付与（公開レコードのみ対象）
  //   ・キーワード: circus と同じく OR ロジック。全語 × 全フィールド(4つ)の
  //     like を1つの大きな OR 節にまとめる。
  //       例: (仕事内容 like "営業" or 求人タイトル like "営業" or …
  //            or 仕事内容 like "IT" or 求人タイトル like "IT" or …)
  //     語同士を AND にすると「全語を含む求人」に絞られ 0 件になりやすい
  //     （circus は or ロジック=いずれかの語を含む、で網羅的に拾う思想）。
  //   ・勤務地/職種/業種の絞り込みは「絞りすぎ厳禁」方針に従いクエリでは行わず、
  //     既存の機械フィルタ(evaluateOne: 勤務地hardFail等)とAI採点に委ねる。
  //     （circus は数値コードで絞れるが kintone は日本語ラベルのため、DB規模149件なら
  //      機械フィルタ側で十分・取りこぼしも防げる）
  _buildQuery(qJson = {}) {
    const clauses = []
    clauses.push('求人公開 in ("可能")')
    const words = Array.isArray(qJson.words) ? qJson.words : []
    const ors = []
    for (const w of words) {
      const esc = kintoneEscape(w)
      for (const f of this.KEYWORD_FIELDS) ors.push(`${f} like "${esc}"`)
    }
    if (ors.length) clauses.push(`(${ors.join(' or ')})`)
    return clauses.join(' and ')
  },

  // 共通 REST 呼び出し（page引数は無視）。
  async _apiCall(query, { totalCount = false, fields = null, limit, offset } = {}) {
    // kintone クエリ記法: limit は offset より前に置く必要がある（順序厳格）。
    let q = query || ''
    if (typeof limit === 'number') q += ` limit ${limit}`
    if (typeof offset === 'number') q += ` offset ${offset}`
    const params = new URLSearchParams()
    params.set('app', String(this.appId))
    params.set('query', q.trim())
    if (totalCount) params.set('totalCount', 'true')
    if (Array.isArray(fields)) for (const f of fields) params.append('fields', f)
    const url = `${this.base}/k/v1/records.json?${params.toString()}`
    const res = await fetch(url, { headers: { 'X-Cybozu-API-Token': this.apiToken } })
    const status = res.status
    let json = null
    try { json = await res.json() } catch {}
    if (status !== 200) {
      const msg = json && (json.message || JSON.stringify(json))
      throw new Error(`kintone API ${status}: ${String(msg).slice(0, 200)}`)
    }
    return json || {}
  },

  // マッチ件数のみ（totalCount）。circus apiCount 相当。
  async apiCount(_page, _token, params = {}) {
    const query = this._buildQuery(params.qJson)
    const json = await this._apiCall(query, { totalCount: true, fields: ['$id'], limit: 1 })
    const n = json.totalCount
    return n == null ? null : parseInt(n, 10)
  },

  // 求人検索（本体）。circus apiSearch 相当。
  // 戻り値: { total, jobs:[生kintoneレコード], status }
  async apiSearch(_page, _token, params = {}) {
    const { limit = 100, offset = 0 } = params
    const query = this._buildQuery(params.qJson)
    // kintone は 1リクエスト最大500件。安全に100件刻みで取得。
    const json = await this._apiCall(query, { limit: Math.min(limit, 500), offset })
    const recs = Array.isArray(json.records) ? json.records : []
    return { total: json.totalCount != null ? parseInt(json.totalCount, 10) : null, jobs: recs, status: 200 }
  },

  // circus と同じく criteria からキーワードを1語抽出（フォールバック用）。
  extractKeyword(criteria) {
    if (criteria.keyword && String(criteria.keyword).trim()) return String(criteria.keyword).trim()
    if (Array.isArray(criteria.jobCategories) && criteria.jobCategories.length) return criteria.jobCategories[0]
    return ''
  },

  // 生 kintone レコード → 内部 NormalizedJob 形式へ変換。
  //   レコードは { フィールドコード: { type, value } } 構造。
  mapApiJob(raw) {
    if (!raw) return null
    const val = (code) => {
      const c = raw[code]
      return c ? c.value : undefined
    }
    const str = (code) => {
      const v = val(code)
      if (v == null) return ''
      if (Array.isArray(v)) return v.filter(Boolean).join('・')
      return String(v)
    }

    const recordId = str('レコード番号') || str('$id') || (raw['$id'] && raw['$id'].value) || ''

    // 職種: 大分類 + 小分類 + まとめ（ユーザ確定: この粒度）
    const jobParts = [str('メイン職種_大分類_'), str('メイン職種_小分類_'), str('サブ職種まとめ')]
      .map((s) => s.trim()).filter(Boolean)
    const jobCategory = [...new Set(jobParts)].join('・')
    const jobCategories = [...new Set(
      [str('メイン職種_大分類_'), str('メイン職種_小分類_'), str('サブ職種_大分類_')].filter(Boolean)
    )]

    // 業種: メイン大分類 + サブ大分類
    const indParts = [str('メイン業種_大分類_'), str('サブ業種_大分類_')].map((s) => s.trim()).filter(Boolean)
    const industry = [...new Set(indParts)].join('・')
    const industries = [...new Set(indParts)]

    // 雇用形態
    const employment = str('雇用形態')

    // 勤務地（MULTI_SELECT → 県ラベル配列）
    const rawLoc = val('勤務地')
    const locations = Array.isArray(rawLoc) ? rawLoc.filter(Boolean) : (rawLoc ? [String(rawLoc)] : [])

    // 年収: 万円 → 円
    const salMin = kintoneNum(str('想定年収_下限_'))
    const salMax = kintoneNum(str('想定年収_上限_'))
    const salaryMin = salMin != null ? Math.round(salMin * 10000) : null
    const salaryMax = salMax != null ? Math.round(salMax * 10000) : null

    // 応募条件（年齢/性別/学歴）— circusの正規化と同じ意味づけ
    const requiredAgeMin = kintoneNum(str('採用可能年齢_下限_'))
    const requiredAgeMax = kintoneNum(str('採用可能年齢_上限_'))
    // 性別: kintoneラベル → circus正規化ラベル(性別不問=null相当)
    const genderRaw = str('性別')
    let requiredGender = null
    if (genderRaw === '男性限定') requiredGender = '男性'
    else if (genderRaw === '女性限定') requiredGender = '女性'
    // 「男性/女性であれば尚良し」「性別不問」は不問扱い(null)
    // 学歴（学歴不問 は null 扱い＝制約なし）
    const eduRaw = str('最終学歴')
    const requiredEducation = (eduRaw && eduRaw !== '学歴不問') ? eduRaw : null

    // 成果報酬（{ type, rate, amount, text }）
    const reward = this._extractReward(raw, str)

    // 未経験可否 / 外国籍（circusの experience[] と同じ語彙）
    const experience = []
    const jobExp = str('職種経験')
    if (jobExp === '職種未経験OK') experience.push('職種未経験OK')
    else if (jobExp === '職種未経験NG') experience.push('職種未経験NG')
    const indExp = str('業種経験')
    if (indExp === '業種未経験OK') experience.push('業種未経験OK')
    else if (indExp === '業種未経験NG') experience.push('業種未経験NG')
    const nationality = str('国籍')
    if (nationality === '外国籍OK') experience.push('外国籍OK')

    // 仕事内容 / 応募資格
    const description = str('仕事内容')
    const requirements = str('応募必須条件')

    // 公開判定: 「求人公開」チェックに「可能」が含まれるか
    const pub = val('求人公開')
    const isOpen = Array.isArray(pub) ? pub.includes('可能') : Boolean(pub)

    return {
      source: 'kintone',
      sourceJobId: String(recordId),
      title: str('求人タイトル') || str('求人タイトル表紙') || '',
      company: str('企業名') || '',
      companyWebsite: str('ウェブサイトURL') || '',
      jobCategory,
      jobCategories,
      industry,
      industries,
      employment,
      locations,
      salaryMin,
      salaryMax,
      overtime: str('月間平均残業時間') || '',
      holiday: str('休日') || '',
      requiredAgeMin,
      requiredAgeMax,
      requiredGender,
      requiredEducation,
      reward,
      requirements,
      description,
      experience,
      url: `${this.base}/k/${this.appId}/show#record=${recordId}`,
      isOpen,
      publishStartedAt: str('作成日時') || null,
      lastUpdatedAt: str('更新日時') || null,
      _raw: raw,
    }
  }, // mapApiJob

  // 成果報酬抽出（kintone版）。circus の extractReward と同じ戻り形状。
  //   成果報酬(ラジオ): 'パーセンテージ' | '一律料金'
  //   一律(数値, 万円) / 成果報酬金額(表示テキスト)
  _extractReward(raw, str) {
    const type = str('成果報酬') // 'パーセンテージ' | '一律料金' | ''
    const text = str('成果報酬金額') || ''
    let rate = null
    let amount = null
    if (type === '一律料金') {
      const fixed = kintoneNum(str('一律'))
      if (fixed != null) amount = Math.round(fixed * 10000) // 万円→円
      // テキストからの補完（"一律50万円"）
      if (amount == null && text) {
        const m = text.match(/([\d.]+)\s*万/)
        if (m) amount = Math.round(parseFloat(m[1]) * 10000)
      }
      return { type: 'fixed', rate: null, amount, text }
    }
    if (type === 'パーセンテージ') {
      const m = text.match(/([\d.]+)\s*[%％]/)
      if (m) rate = parseFloat(m[1])
      return { type: 'rate', rate, amount: null, text }
    }
    return { type: 'unknown', rate: null, amount: null, text }
  },
}

export const ADAPTERS = {
  circus: circusAdapter,
  hitolink: hitolinkAdapter,
  jobins: jobinsAdapter,
  kintone: kintoneAdapter,
}
