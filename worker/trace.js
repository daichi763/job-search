// ============================================================
// 全求人トレース(ミラーリング)処理
//   手動検索モード用。4DBの全求人を「条件なし全件」で取得し、
//   webapp側 /api/ingest/trace-result へPOSTして自社DB(jobs)へupsertさせる。
//   最後に /api/ingest/trace-close を呼び、今回見つからなかった求人を掲載終了にする。
//
//   AI検索(processSource)とは完全に独立。既存フローには一切触れない。
// ============================================================

// トレースの調整パラメータ（環境変数で上書き可）
const TRACE = {
  PAGE_SIZE: parseInt(process.env.TRACE_PAGE_SIZE || '100', 10), // 1ページ取得件数
  MAX_JOBS: parseInt(process.env.TRACE_MAX_JOBS || '100000', 10), // 安全弁(媒体あたり上限)
  PUSH_BATCH: parseInt(process.env.TRACE_PUSH_BATCH || '50', 10), // まとめてPOSTする件数
  PAGE_DELAY_MS: parseInt(process.env.TRACE_PAGE_DELAY_MS || '400', 10), // ページ間の待機
  PAGE_RETRY: parseInt(process.env.TRACE_PAGE_RETRY || '3', 10), // 1ページの最大リトライ回数
  PAGE_RETRY_DELAY_MS: parseInt(process.env.TRACE_PAGE_RETRY_DELAY_MS || '1500', 10), // リトライ間隔
  MAX_CONSECUTIVE_FAIL: parseInt(process.env.TRACE_MAX_CONSECUTIVE_FAIL || '5', 10), // 連続失敗で打ち切り
}

// 内容ハッシュ（差分同期の判定用）。
//   ★ src/lib/db.ts の computeContentHash と完全に同じロジックにすること。
//     (webapp側の upsert 時に保存するハッシュと突き合わせるため)
export function computeContentHash(job) {
  const rawReward = job.reward || {}
  const arr = (v) => JSON.stringify(Array.isArray(v) ? v : [])
  const s = [
    job.title, job.company, job.jobCategory, job.industry, job.employment,
    arr(job.locations), job.salaryMin, job.salaryMax,
    job.overtime, job.holiday, job.benefits, job.requirements, job.description,
    job.url, job.companyWebsite || '', arr(job.jobCategories), arr(job.industries),
    arr(job.positions), job.careerStage || '', arr(job.experience),
    job.requiredAgeMin ?? null, job.requiredAgeMax ?? null,
    job.requiredGender ?? null, job.requiredEducation ?? null,
    rawReward.type ?? null, rawReward.rate ?? null, rawReward.amount ?? null, rawReward.text ?? '',
  ].join('\u0001')
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0
  }
  return h.toString(16)
}

// 1媒体の全件トレースを実行する。
//   deps: { adapter, page, env, appUrl, token(=INGEST_TOKEN), source, traceJobId, startedAt, log }
export async function traceSource(deps) {
  const { adapter, page, env, appUrl, ingestToken, source, traceJobId, startedAt, log } = deps

  const post = async (path, body) => {
    const res = await fetch(`${appUrl}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Ingest-Token': ingestToken },
      body: JSON.stringify(body),
    })
    if (!res.ok) throw new Error(`${path} -> HTTP ${res.status}`)
    return res.json().catch(() => ({}))
  }
  const reportState = (patch) =>
    post('/api/ingest/trace-state', { traceJobId, source, ...patch }).catch((e) => log(`[trace:${source}] state報告失敗: ${e.message}`))

  try {
    await reportState({ phase: 'fetching', message: 'ログイン中…' })
    await adapter.login(page, env)

    // 認証トークン取得（circus等はログアウト→再ログイン復旧を1回試す）
    let token
    try {
      token = await adapter.getAuthToken(page)
    } catch (e) {
      if (typeof adapter.logout === 'function') {
        log(`[trace:${source}] トークン取得失敗、再ログイン: ${e.message}`)
        await adapter.logout(page)
        await adapter.login(page, env)
        token = await adapter.getAuthToken(page)
      } else {
        throw e
      }
    }

    // 「条件なし=全件」のクエリ。circus/hitolink/jobins/kintone すべて
    // buildQJson({}) が空条件(全件)を表す。
    const qJson = adapter.buildQJson({})
    const emptyParams = { qJson, filters: {} }

    // 差分同期: 既存の source_job_id → content_hash マップを取得。
    //   IDが一致し内容も同じ求人は upsert せず「掲載確認印」だけ更新して高速化。
    let existingHashes = {}
    try {
      const r = await fetch(`${appUrl}/api/ingest/trace-hashes?source=${encodeURIComponent(source)}`, {
        headers: { 'X-Ingest-Token': ingestToken },
      })
      if (r.ok) {
        const j = await r.json()
        existingHashes = (j && j.hashes) || {}
      }
    } catch (e) {
      log(`[trace:${source}] 既存ハッシュ取得失敗（全件upsertで続行）: ${e.message}`)
    }
    const existingCount = Object.keys(existingHashes).length
    log(`[trace:${source}] 差分同期: 既存 ${existingCount} 件`)

    // 総件数を把握
    let total = null
    try {
      total = await adapter.apiCount(page, token, emptyParams)
    } catch (e) {
      log(`[trace:${source}] apiCount失敗（続行）: ${e.message}`)
    }
    log(`[trace:${source}] 全件トレース開始 総数=${total ?? '?'}件`)
    await reportState({ phase: 'fetching', total: total ?? null, message: `全${(total ?? 0).toLocaleString()}件を取得開始…` })

    // ページングで全件取得 → バッチでupsert払い出し
    let fetched = 0     // 媒体から取得できた総件数(スキップ含む)
    let upserted = 0    // 実際にupsertした件数(新規+内容変化)
    let added = 0       // うち新規
    let skipped = 0     // 差分同期でスキップした件数(内容変化なし)
    let failedPages = 0 // 取得に失敗して諦めたページ数
    let buffer = []       // upsert対象のバッファ
    let touchIds = []     // スキップ(=軽量更新)対象のID
    const cap = total != null ? Math.min(total, TRACE.MAX_JOBS) : TRACE.MAX_JOBS

    const flush = async () => {
      if (!buffer.length) return
      const r = await post('/api/ingest/trace-result', { jobs: buffer })
      upserted += buffer.length
      added += (r && typeof r.added === 'number') ? r.added : 0
      buffer = []
      await reportState({ phase: 'upserting', fetched, upserted, added, skipped, message: `${upserted.toLocaleString()}件を自社DBへ保存 / ${skipped.toLocaleString()}件スキップ…` })
    }
    // スキップ分の掲載確認印をまとめて更新
    const flushTouch = async () => {
      if (!touchIds.length) return
      try {
        await post('/api/ingest/trace-touch', { source, sourceJobIds: touchIds })
      } catch (e) {
        log(`[trace:${source}] touch失敗（続行）: ${e.message}`)
      }
      touchIds = []
    }

    // 1ページを最大 PAGE_RETRY 回まで試す。取れなければ null を返す（=そのページは諦める）。
    const fetchPageWithRetry = async (offset) => {
      const pageNo = Math.floor(offset / TRACE.PAGE_SIZE) + 1
      let lastErr = null
      for (let attempt = 1; attempt <= TRACE.PAGE_RETRY; attempt++) {
        try {
          const res = await adapter.apiSearch(page, token, {
            ...emptyParams,
            limit: TRACE.PAGE_SIZE,
            offset,
            pageNo,
          })
          return res
        } catch (e) {
          lastErr = e
          log(`[trace:${source}] apiSearch失敗 p${pageNo}(offset=${offset}) try ${attempt}/${TRACE.PAGE_RETRY}: ${e.message}`)
          // 認証切れの可能性 → トークン再取得を試みる（1回）
          if (attempt === 1 && /401|403|token|auth|認証/i.test(e.message)) {
            try {
              if (typeof adapter.logout === 'function') await adapter.logout(page)
              await adapter.login(page, env)
              token = await adapter.getAuthToken(page)
              log(`[trace:${source}] 再ログイン→トークン再取得OK`)
            } catch (re) {
              log(`[trace:${source}] 再ログイン失敗: ${re.message}`)
            }
          }
          if (attempt < TRACE.PAGE_RETRY) {
            await page.waitForTimeout(TRACE.PAGE_RETRY_DELAY_MS * attempt)
          }
        }
      }
      log(`[trace:${source}] p${pageNo} を ${TRACE.PAGE_RETRY} 回試すも失敗、スキップして継続`)
      return null
    }

    let consecutiveFail = 0
    for (let offset = 0; offset < cap; offset += TRACE.PAGE_SIZE) {
      const res = await fetchPageWithRetry(offset)

      // ★ B1修正: ページ取得に失敗しても break せず「スキップして次ページへ継続」。
      //   ただし連続で MAX_CONSECUTIVE_FAIL ページ失敗したら異常とみなし打ち切る。
      if (res == null) {
        failedPages++
        consecutiveFail++
        if (consecutiveFail >= TRACE.MAX_CONSECUTIVE_FAIL) {
          log(`[trace:${source}] 連続${consecutiveFail}ページ失敗、以降を打ち切り`)
          break
        }
        if (TRACE.PAGE_DELAY_MS > 0) await page.waitForTimeout(TRACE.PAGE_DELAY_MS)
        continue
      }
      consecutiveFail = 0

      const rawJobs = (res && res.jobs) || []
      if (!rawJobs.length) break // これ以上ない（正常終了）

      for (const raw of rawJobs) {
        let job
        try { job = adapter.mapApiJob(raw) } catch { job = null }
        // ★ B2修正: sourceJobId が空文字/null は取り込まない（重複衝突防止）
        const sid = job && job.sourceJobId != null ? String(job.sourceJobId).trim() : ''
        if (!job || !sid) continue
        fetched++

        // ★ B2差分同期: 既存かつ内容ハッシュ一致 → upsertせず touch(軽量更新)へ
        const existingHash = existingHashes[sid]
        if (existingHash !== undefined) {
          const newHash = computeContentHash(job)
          if (existingHash && existingHash === newHash) {
            skipped++
            touchIds.push(sid)
            if (touchIds.length >= 200) await flushTouch()
            continue
          }
        }
        buffer.push(job)
        if (buffer.length >= TRACE.PUSH_BATCH) await flush()
      }

      await reportState({ phase: 'fetching', fetched, upserted, added, skipped, total: total ?? null, message: `取得 ${fetched.toLocaleString()} / ${(total ?? '?')}件（更新${upserted} スキップ${skipped}）…` })

      // 総数が判明していて取り切ったら終了
      if (total != null && fetched >= total) break
      if (TRACE.PAGE_DELAY_MS > 0) await page.waitForTimeout(TRACE.PAGE_DELAY_MS)
    }
    await flush()
    await flushTouch()

    // 掲載終了検知: 今回の同期(startedAt以降)で trace_sync_at が更新されなかった
    // この媒体の求人を掲載終了(is_open=0)にする。
    await reportState({ phase: 'closing', fetched, upserted, added, skipped, failedPages, message: '掲載終了求人を判定中…' })
    let closed = 0
    try {
      const r = await post('/api/ingest/trace-close', { source, startedAt })
      closed = (r && typeof r.closed === 'number') ? r.closed : 0
    } catch (e) {
      log(`[trace:${source}] close失敗: ${e.message}`)
    }

    const failNote = failedPages > 0 ? ` / ⚠取得失敗${failedPages}ページ` : ''
    await reportState({
      phase: 'done', fetched, upserted, added, closed, skipped, failedPages, total: total ?? null,
      message: `完了：更新${upserted.toLocaleString()}件 / 新規${added.toLocaleString()}件 / スキップ${skipped.toLocaleString()}件 / 掲載終了${closed.toLocaleString()}件${failNote}`,
    })
    log(`[trace:${source}] 完了 更新=${upserted} 新規=${added} スキップ=${skipped} 掲載終了=${closed} 失敗ページ=${failedPages}`)
    return { upserted, added, closed, skipped, failedPages }
  } catch (e) {
    log(`[trace:${source}] エラー: ${e.message}`)
    await reportState({ phase: 'error', message: `エラー: ${e.message}` })
    return { error: e.message }
  }
}
