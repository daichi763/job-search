// ============================================================
// 各求人サイトのスクレイピング・アダプタ
//
// ⚠️ 重要: 以下のセレクタ・ページ遷移は「雛形(テンプレート)」です。
//   実際のサイトのHTML構造に合わせて、TODO箇所を埋める必要があります。
//   手元PCで HEADLESS=false にして実画面を見ながら調整してください。
//
// 各アダプタは共通インターフェイスを実装します:
//   - login(page): ログイン処理
//   - fetchJobs(page, criteria, onJob): 求人を検索・抽出し、1件ごとに onJob(job) を呼ぶ
//
// onJob に渡す job オブジェクトは Cloudflare側の NormalizedJob 形式:
//   { source, sourceJobId, title, company, jobCategory, industry, employment,
//     locations:[], salaryMin, salaryMax, overtime, holiday, benefits,
//     requirements, description, url, isOpen }
// ============================================================

// ---------- ①circusAGENT ----------
export const circusAdapter = {
  source: 'circus',
  async login(page, env) {
    await page.goto(env.CIRCUS_LOGIN_URL, { waitUntil: 'networkidle' })
    // TODO: ログインフォームのセレクタを実画面で確認して調整
    // 例:
    // await page.fill('input[name="email"]', env.CIRCUS_ID)
    // await page.fill('input[name="password"]', env.CIRCUS_PW)
    // await page.click('button[type="submit"]')
    // await page.waitForLoadState('networkidle')
    throw new Error('circusAdapter.login は未実装です。実画面を見てセレクタを設定してください。')
  },
  async fetchJobs(page, criteria, onJob) {
    // TODO: 求人一覧ページへ遷移 → ページング → 各求人の詳細を抽出
    // 抽出した求人ごとに await onJob(normalizedJob) を呼ぶ（逐次払い出し）
    //
    // 例(擬似コード):
    // await page.goto('https://circus-job.com/jobs')
    // while (hasNextPage) {
    //   const cards = await page.$$('.job-card')
    //   for (const card of cards) {
    //     const job = {
    //       source: 'circus',
    //       sourceJobId: await card.getAttribute('data-id'),
    //       title: await card.$eval('.title', el => el.textContent.trim()),
    //       company: ...,
    //       locations: [...],
    //       salaryMin: ..., salaryMax: ...,
    //       description: ...,
    //       url: ...,
    //       isOpen: true,
    //     }
    //     await onJob(job)
    //   }
    //   // 次ページへ
    // }
    return
  },
}

// ---------- ②ヒトリンク ----------
export const hitolinkAdapter = {
  source: 'hitolink',
  async login(page, env) {
    await page.goto(env.HITOLINK_LOGIN_URL, { waitUntil: 'networkidle' })
    // TODO: セレクタを実画面で確認
    throw new Error('hitolinkAdapter.login は未実装です。')
  },
  async fetchJobs(page, criteria, onJob) {
    // TODO
    return
  },
}

// ---------- ③ジョビンズ ----------
export const jobinsAdapter = {
  source: 'jobins',
  async login(page, env) {
    await page.goto(env.JOBINS_LOGIN_URL, { waitUntil: 'networkidle' })
    // TODO: セレクタを実画面で確認
    throw new Error('jobinsAdapter.login は未実装です。')
  },
  async fetchJobs(page, criteria, onJob) {
    // TODO
    return
  },
}

export const ADAPTERS = {
  circus: circusAdapter,
  hitolink: hitolinkAdapter,
  jobins: jobinsAdapter,
}
