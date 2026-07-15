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
  buildSearchUrl(criteria, pageNo) {
    const kw = this.extractKeyword(criteria)
    const qJson = encodeURIComponent(
      JSON.stringify([
        { option: 1, keyword: '', logicType: 'and' },
        { option: 1, keyword: kw, logicType: 'or' },
        { option: 1, keyword: '', logicType: 'excludeAnd' },
        { option: 1, keyword: '', logicType: 'excludeOr' },
      ])
    )
    return (
      `${this.base}/search?qJson=${qJson}` +
      `&selectionDaysIncludingDuringMeasurement=included` +
      `&page=${pageNo}&orderBy=recommendScore&order=desc&resume.selectionCount=`
    )
  },

  async fetchJobs(page, criteria, onJob) {
    // circus /search は「仮想スクロール」。1ページ25件だがDOM上には常に2〜3枚しか無い。
    // ページ内をゆっくりスクロールしながらカードを収集する。
    // 取得しすぎると時間がかかるため、topN の数倍 or env上限で頭打ち。
    const cap = parseInt(process.env.CIRCUS_MAX_SCAN || '75', 10)
    const maxScan = criteria._maxScan || Math.min(cap, Math.max(25, (criteria.topN || 10) * 5))
    const PAGE_SIZE = 25
    const maxPages = Math.ceil(maxScan / PAGE_SIZE)

    const seenIds = new Set()
    let scanned = 0

    for (let pageNo = 1; pageNo <= maxPages && scanned < maxScan; pageNo++) {
      const url = this.buildSearchUrl(criteria, pageNo)
      await page.goto(url, { waitUntil: 'networkidle', timeout: 60000 })
      await page.waitForTimeout(3000)

      // カードの初回描画を待つ（最大20秒）。0件検索ならスキップ。
      const appeared = await page
        .waitForSelector('[data-testid="job-search-result-card"]', { timeout: 20000, state: 'attached' })
        .then(() => true)
        .catch(() => false)
      if (!appeared) {
        // 件数表示があるのにカードが出ない場合、少しスクロールして再待機
        await page.mouse.wheel(0, 500)
        await page.waitForTimeout(2500)
        const retry = await page.$('[data-testid="job-search-result-card"]')
        if (!retry) break // 本当に0件
      }

      // このページで収集済みのカードIDを追跡。scrollHが伸びなくなるまで（＝末尾到達）繰り返す。
      let pageSeen = new Set()
      let stagnant = 0
      for (let step = 0; step < 40 && scanned < maxScan; step++) {
        const cards = await this.readVisibleCards(page)
        let newInThisStep = 0
        for (const card of cards) {
          if (!card.id || seenIds.has(card.id)) continue
          seenIds.add(card.id)
          pageSeen.add(card.id)
          newInThisStep++
          scanned++
          try {
            const job = this.cardToJob(card)
            if (job) await onJob(job)
          } catch (e) {
            console.error(`circus カード解析失敗 id=${card.id}:`, e.message)
          }
          if (scanned >= maxScan) break
        }
        // 末尾判定: 新規カードが数ステップ連続で0なら終了
        if (newInThisStep === 0) stagnant++
        else stagnant = 0
        if (stagnant >= 5) break
        // このページで25件そろったら次ページへ
        if (pageSeen.size >= PAGE_SIZE) break
        await page.mouse.wheel(0, 700)
        await page.waitForTimeout(550)
      }

      // このページでカードが1件も取れなければ、それ以上ページは無いとみなす
      if (pageSeen.size === 0) break
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
