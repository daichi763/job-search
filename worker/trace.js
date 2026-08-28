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
    let fetched = 0
    let upserted = 0
    let added = 0
    let buffer = []
    const cap = total != null ? Math.min(total, TRACE.MAX_JOBS) : TRACE.MAX_JOBS

    const flush = async () => {
      if (!buffer.length) return
      const r = await post('/api/ingest/trace-result', { jobs: buffer })
      upserted += buffer.length
      added += (r && typeof r.added === 'number') ? r.added : 0
      buffer = []
      await reportState({ phase: 'upserting', fetched, upserted, added, message: `${upserted.toLocaleString()}件を自社DBへ保存済み…` })
    }

    for (let offset = 0; offset < cap; offset += TRACE.PAGE_SIZE) {
      let res
      try {
        res = await adapter.apiSearch(page, token, {
          ...emptyParams,
          limit: TRACE.PAGE_SIZE,
          offset,
          pageNo: Math.floor(offset / TRACE.PAGE_SIZE) + 1,
        })
      } catch (e) {
        log(`[trace:${source}] apiSearch失敗 offset=${offset}: ${e.message}`)
        break
      }
      const rawJobs = (res && res.jobs) || []
      if (!rawJobs.length) break // これ以上ない

      for (const raw of rawJobs) {
        let job
        try { job = adapter.mapApiJob(raw) } catch { job = null }
        if (job && job.sourceJobId != null) {
          buffer.push(job)
          fetched++
        }
        if (buffer.length >= TRACE.PUSH_BATCH) await flush()
      }

      await reportState({ phase: 'fetching', fetched, upserted, added, total: total ?? null, message: `取得 ${fetched.toLocaleString()} / ${(total ?? '?')}件…` })

      // 総数が判明していて取り切ったら終了
      if (total != null && fetched >= total) break
      if (TRACE.PAGE_DELAY_MS > 0) await page.waitForTimeout(TRACE.PAGE_DELAY_MS)
    }
    await flush()

    // 掲載終了検知: 今回の同期(startedAt以降)で trace_sync_at が更新されなかった
    // この媒体の求人を掲載終了(is_open=0)にする。
    await reportState({ phase: 'closing', fetched, upserted, added, message: '掲載終了求人を判定中…' })
    let closed = 0
    try {
      const r = await post('/api/ingest/trace-close', { source, startedAt })
      closed = (r && typeof r.closed === 'number') ? r.closed : 0
    } catch (e) {
      log(`[trace:${source}] close失敗: ${e.message}`)
    }

    await reportState({
      phase: 'done', fetched, upserted, added, closed, total: total ?? null,
      message: `完了：取得${upserted.toLocaleString()}件 / 新規${added.toLocaleString()}件 / 掲載終了${closed.toLocaleString()}件`,
    })
    log(`[trace:${source}] 完了 取得=${upserted} 新規=${added} 掲載終了=${closed}`)
    return { upserted, added, closed }
  } catch (e) {
    log(`[trace:${source}] エラー: ${e.message}`)
    await reportState({ phase: 'error', message: `エラー: ${e.message}` })
    return { error: e.message }
  }
}
