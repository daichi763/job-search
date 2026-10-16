// 新しいAI検索（求人DB方式）の画面
(function () {
  'use strict'
  var $ = function (s, el) { return (el || document).querySelector(s) }
  var $$ = function (s, el) { return Array.prototype.slice.call((el || document).querySelectorAll(s)) }
  var esc = function (s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] }) }
  var ROLE = document.body.getAttribute('data-role')
  var SOURCE_LABEL = { circus: 'circus', hitolink: 'ヒトリンク', jobins: 'ジョビンズ', kintone: 'kintone' }
  var KIND_LABEL = { cv: '職務経歴書', resume: '履歴書', other: 'その他' }
  var FEATURE_LABEL = { remote: 'リモート可', flex: 'フレックス', side_job: '副業可', no_transfer: '転勤なし', holidays_120: '年休120日+', weekend_off: '土日祝休み', inexperienced_ok: '未経験可', short_time: '時短可' }
  var STAGE_PCT = { profile: 8, plan: 12, pool: 18, screen: 45, deep: 80, write: 92, done: 100 }

  var state = { candidate: null, searchId: null, timer: null, result: null, tab: 'recommended', jobKeys: [] }

  function api(path, opts) {
    opts = opts || {}
    return fetch('/api/ai' + path, {
      method: opts.method || 'GET', credentials: 'same-origin',
      headers: opts.body ? { 'Content-Type': 'application/json' } : {},
      body: opts.body ? JSON.stringify(opts.body) : undefined,
    }).then(function (r) {
      if (r.status === 401) { location.href = '/login?next=' + encodeURIComponent(location.pathname + location.search); throw new Error('ログインしてください') }
      return r.json().catch(function () { return {} }).then(function (d) { if (!r.ok) throw new Error(d.error || ('エラー ' + r.status)); return d })
    })
  }
  function toast(msg, bad) {
    var t = document.createElement('div')
    t.className = 'fixed left-1/2 -translate-x-1/2 bottom-16 z-50 text-sm rounded-lg shadow px-4 py-2 ' + (bad ? 'bg-red-600 text-white' : 'bg-slate-800 text-white')
    t.textContent = msg; document.body.appendChild(t)
    setTimeout(function () { t.remove() }, bad ? 6000 : 2500)
  }
  var man = function (v) { return v ? Math.round(v / 10000) : '?' }
  var jst = function (s) { if (!s) return ''; var d = new Date(String(s).replace(' ', 'T') + (/Z|\+/.test(s) ? '' : 'Z')); return isNaN(d) ? s : d.toLocaleString('ja-JP', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }) }
  // 紹介報酬（割合・固定）。割合が30%以上は色を変えて目立たせる
  var REWARD_HIGH_RATE = 30
  function rewardInfo(r) {
    var t = r.reward_type, rate = r.reward_rate != null ? Number(r.reward_rate) : null, amt = r.reward_amount != null ? Number(r.reward_amount) : null
    if (rate == null && t !== 'fixed' && r.reward) { var m = String(r.reward).match(/([\d.]+)\s*[%％]/); if (m) { rate = parseFloat(m[1]); t = 'rate' } }
    if (t === 'rate' && rate != null) {
      var base = r.salary_max || r.salary_min
      var est = base ? Math.round(base * rate / 100 / 10000) : null
      return { kind: 'rate', high: rate >= REWARD_HIGH_RATE, text: '理論年収の' + rate + '%', sub: est ? '目安 約' + est.toLocaleString() + '万円' : '', short: rate + '%' }
    }
    if (t === 'fixed' && amt != null) { var mn = Math.round(amt / 10000 * 10) / 10; return { kind: 'fixed', high: false, text: '一律' + mn.toLocaleString() + '万円', sub: '', short: mn + '万円' } }
    if (r.reward) return { kind: 'other', high: false, text: String(r.reward).slice(0, 40), sub: '', short: String(r.reward).slice(0, 12) }
    return null
  }
  function rewardBadge(r) {
    var w = rewardInfo(r)
    if (!w) return '<span class="reward-badge rounded px-1.5 py-0.5 bg-slate-50 text-slate-400"><i class="fas fa-hand-holding-dollar mr-1"></i>紹介報酬 不明</span>'
    var cls = w.high ? 'bg-rose-600 text-white font-bold' : w.kind === 'rate' ? 'bg-amber-100 text-amber-800 font-semibold' : w.kind === 'fixed' ? 'bg-teal-100 text-teal-800 font-semibold' : 'bg-slate-100 text-slate-700'
    var tip = w.kind === 'rate' ? (w.sub ? '目安は年収の上限で計算した金額です' : '') + (w.high ? '（' + REWARD_HIGH_RATE + '%以上）' : '') : ''
    return '<span class="reward-badge rounded px-1.5 py-0.5 ' + cls + '"' + (tip ? ' title="' + esc(tip) + '"' : '') + '><i class="fas fa-hand-holding-dollar mr-1"></i>紹介報酬 ' + esc(w.text) + (w.sub ? ' <span class="font-normal opacity-80">（' + esc(w.sub) + '）</span>' : '') + '</span>'
  }
  var yen = function (usd) { return usd == null ? '' : '約' + Math.round(usd * 150) + '円' }
  var setUrl = function () {
    var p = new URLSearchParams()
    if (state.candidate) p.set('candidate', state.candidate.id)
    if (state.searchId) p.set('search', state.searchId)
    history.replaceState(null, '', '/ai' + (p.toString() ? '?' + p : ''))
  }

  // ---------------- 条件フォーム ----------------
  var form = $('#search-form')
  function readCriteria() {
    var f = form, c = {
      freeText: f.freeText.value.trim(), memo: f.memo.value.trim(), desiredJobs: f.desiredJobs.value.trim(),
      salaryMin: f.salaryMin.value, age: f.age.value, topN: Number(f.topN.value) || 20, gender: f.gender.value, education: f.education.value,
      includeNationwide: f.includeNationwide.checked,
    }
    ;['locations', 'features', 'employment', 'sources'].forEach(function (n) { c[n] = $$('input[name="' + n + '"]:checked', f).map(function (x) { return x.value }) })
    if (state.jobKeys.length) c.jobKeys = state.jobKeys
    return c
  }
  function readOptions() { return { depth: form.depth.value, costMode: form.costMode.value || undefined, useDocuments: form.useDocuments.checked } }
  function fillCriteria(c, o) {
    c = c || {}; o = o || c.options || {}
    form.freeText.value = c.freeText || ''; form.memo.value = c.memo || ''; form.desiredJobs.value = c.desiredJobs || ''
    form.salaryMin.value = c.salaryMin || ''; form.age.value = c.age || ''; form.topN.value = c.topN || 20
    form.gender.value = c.gender || ''; form.education.value = c.education || ''
    form.includeNationwide.checked = c.includeNationwide !== false
    ;['locations', 'features', 'employment', 'sources'].forEach(function (n) {
      var vs = c[n] || []; $$('input[name="' + n + '"]', form).forEach(function (x) { x.checked = vs.indexOf(x.value) >= 0 })
    })
    form.depth.value = o.depth || 'standard'; form.costMode.value = o.costMode || ''; form.useDocuments.checked = o.useDocuments !== false
  }
  $('#reset-button').addEventListener('click', function () {
    if (!confirm('検索条件をすべて消します。よろしいですか？（求職者の登録内容は消えません）')) return
    fillCriteria({}); state.jobKeys = []; renderJobKeys()
  })
  function renderJobKeys() {
    $('#job-keys-box').classList.toggle('hidden', !state.jobKeys.length)
    $('#job-keys-count').textContent = state.jobKeys.length
  }
  $('#clear-job-keys').addEventListener('click', function () { state.jobKeys = []; renderJobKeys() })

  // ---------------- 求職者 ----------------
  function renderCandidate() {
    var c = state.candidate
    $('#candidate-empty').classList.toggle('hidden', !!c)
    $('#candidate-card').classList.toggle('hidden', !c)
    if (!c) return setUrl()
    $('#candidate-name').textContent = c.name
    $('#candidate-no').textContent = 'No.' + c.id + (c.name_kana ? ' / ' + c.name_kana : '')
    $('#candidate-meta').textContent = '登録 ' + jst(c.created_at) + (c.owner_user_name ? ' / 主担当 ' + c.owner_user_name : '')
    $('#document-list').innerHTML = c.documents.length ? c.documents.map(function (d) {
      return '<li class="flex items-center gap-2 bg-slate-50 rounded px-2 py-1"><i class="fas fa-file-pdf text-red-500"></i><span class="truncate flex-1" title="' + esc(d.filename) + '">' + esc(KIND_LABEL[d.kind] || d.kind) + '：' + esc(d.filename || '') + '</span>' +
        '<span class="text-slate-400">' + (d.pages || '?') + 'p</span><button class="doc-delete text-slate-400 hover:text-red-600" data-id="' + d.id + '" title="削除"><i class="fas fa-trash"></i></button></li>'
    }).join('') : '<li class="text-slate-400">書類はまだありません（なくても検索できます）</li>'
    $('#profile-button').classList.toggle('hidden', !c.documents.length)
    $('#referral-count').textContent = c.referrals.length ? c.referrals.length + '件' : ''
    $('#referral-list').innerHTML = c.referrals.length ? c.referrals.map(function (r) {
      return '<li class="flex items-center gap-2"><span class="truncate flex-1" title="' + esc(r.title) + '">' + esc(r.title || r.job_key) + (r.company ? '（' + esc(r.company) + '）' : '') + '</span>' +
        '<span class="text-slate-400 shrink-0">' + jst(r.created_at) + '</span><button class="ref-delete text-slate-400 hover:text-red-600" data-key="' + esc(r.job_key) + '" title="紹介済みを取り消す"><i class="fas fa-xmark"></i></button></li>'
    }).join('') : '<li class="text-slate-400">まだありません</li>'
    $('#candidate-search-list').innerHTML = c.searches.length ? c.searches.map(function (s) {
      return '<li><button class="open-search w-full text-left hover:bg-indigo-50 rounded px-1 py-0.5" data-id="' + esc(s.id) + '">' +
        '<span class="text-slate-500">' + jst(s.created_at) + '</span> ' + statusBadge(s.status) + ' ' + (s.recommended != null ? s.recommended + '件' : '') + ' <span class="text-slate-400">' + esc(s.user_name || '') + '</span>' +
        '<span class="block truncate text-slate-600">' + esc(s.freeText || '（要望なし）') + '</span></button></li>'
    }).join('') : '<li class="text-slate-400">まだありません</li>'
    setUrl()
  }
  function loadCandidate(id, opts) {
    return api('/candidates/' + id).then(function (c) {
      state.candidate = c; renderCandidate()
      if (opts && opts.fill && c.conditions && Object.keys(c.conditions).length) fillCriteria(c.conditions)
      return c
    })
  }
  function statusBadge(s) {
    var m = { queued: ['順番待ち', 'bg-amber-100 text-amber-700'], running: ['実行中', 'bg-blue-100 text-blue-700'], done: ['完了', 'bg-emerald-100 text-emerald-700'], error: ['エラー', 'bg-red-100 text-red-700'], cancelled: ['中止', 'bg-slate-100 text-slate-600'] }[s] || [s, 'bg-slate-100']
    return '<span class="text-[10px] rounded px-1.5 py-0.5 ' + m[1] + '">' + m[0] + '</span>'
  }

  // 呼び出し
  var cDlg = $('#candidate-dialog'), searchTimer = null
  function searchCandidates() {
    var q = $('#candidate-search-input').value
    api('/candidates?limit=50&q=' + encodeURIComponent(q) + ($('#mine-only').checked ? '&mine=1' : '')).then(function (d) {
      $('#candidate-results').innerHTML = d.items.length ? d.items.map(function (c) {
        return '<li><button class="pick w-full text-left px-2 py-2 hover:bg-indigo-50 rounded" data-id="' + c.id + '">' +
          '<span class="font-semibold">' + esc(c.name) + '</span> <span class="text-xs text-slate-500">No.' + c.id + (c.name_kana ? ' / ' + esc(c.name_kana) : '') + '</span>' +
          '<span class="block text-[11px] text-slate-500">書類 ' + c.doc_count + ' / 検索 ' + c.search_count + '回' + (c.last_search_at ? '（最終 ' + jst(c.last_search_at) + '）' : '') + ' / 紹介済み ' + c.referral_count + (c.owner_user_name ? ' / 主担当 ' + esc(c.owner_user_name) : '') + '</span></button></li>'
      }).join('') : '<li class="text-sm text-slate-400 py-4 text-center">見つかりません</li>'
    }).catch(function (e) { toast(e.message, true) })
  }
  $('#pick-candidate-button').addEventListener('click', function () { cDlg.showModal(); $('#candidate-search-input').value = ''; searchCandidates(); $('#candidate-search-input').focus() })
  $('#candidate-search-input').addEventListener('input', function () { clearTimeout(searchTimer); searchTimer = setTimeout(searchCandidates, 250) })
  $('#mine-only').addEventListener('change', searchCandidates)
  $('#candidate-results').addEventListener('click', function (e) {
    var b = e.target.closest('.pick'); if (!b) return
    cDlg.close()
    loadCandidate(b.getAttribute('data-id'), { fill: true }).then(function (c) {
      clearResult()
      if (c.searches[0] && c.searches[0].status !== 'error') openSearch(c.searches[0].id)
    }).catch(function (e) { toast(e.message, true) })
  })

  // 登録・編集
  var eDlg = $('#candidate-edit-dialog'), eForm = $('#candidate-edit-form'), editing = null
  function openEdit(c) {
    editing = c; eForm.reset(); $('#candidate-edit-error').classList.add('hidden')
    $('#candidate-edit-title').textContent = c ? '求職者を編集（No.' + c.id + '）' : '求職者を登録'
    eForm.name.value = c ? c.name : ''; eForm.name_kana.value = c ? (c.name_kana || '') : ''
    $('#archive-candidate-button').classList.toggle('hidden', !c)
    $('#delete-candidate-button').classList.toggle('hidden', !c || ROLE !== 'admin')
    eDlg.showModal(); eForm.name.focus()
  }
  $('#new-candidate-button').addEventListener('click', function () { openEdit(null) })
  $('#edit-candidate-button').addEventListener('click', function () { openEdit(state.candidate) })
  $('#clear-candidate-button').addEventListener('click', function () { state.candidate = null; renderCandidate() })
  eForm.addEventListener('submit', function (e) {
    e.preventDefault()
    var body = { name: eForm.name.value, name_kana: eForm.name_kana.value }
    var p = editing ? api('/candidates/' + editing.id, { method: 'PATCH', body: body }).then(function () { return { id: editing.id } }) : api('/candidates', { method: 'POST', body: body })
    p.then(function (r) { eDlg.close(); return loadCandidate(r.id) }).then(function () { toast(editing ? '保存しました' : '登録しました（No.' + state.candidate.id + '）') })
      .catch(function (err) { var el = $('#candidate-edit-error'); el.textContent = err.message; el.classList.remove('hidden') })
  })
  $('#archive-candidate-button').addEventListener('click', function () {
    if (!editing || !confirm(editing.name + ' さんをアーカイブします（一覧に出なくなります。データは残ります）')) return
    api('/candidates/' + editing.id, { method: 'PATCH', body: { archived: true } }).then(function () { eDlg.close(); state.candidate = null; renderCandidate(); toast('アーカイブしました') }).catch(function (e) { toast(e.message, true) })
  })
  $('#delete-candidate-button').addEventListener('click', function () {
    if (!editing || !confirm(editing.name + ' さんの書類・検索結果・紹介済みをすべて完全に削除します。元に戻せません。よろしいですか？')) return
    api('/candidates/' + editing.id, { method: 'DELETE' }).then(function () { eDlg.close(); state.candidate = null; renderCandidate(); clearResult(); toast('削除しました') }).catch(function (e) { toast(e.message, true) })
  })

  // 書類
  $('#document-input').addEventListener('change', function (e) {
    var files = Array.prototype.slice.call(e.target.files || []); e.target.value = ''
    if (!state.candidate || !files.length) return
    var kind = $('#document-kind').value
    var chain = Promise.resolve()
    files.forEach(function (file) {
      chain = chain.then(function () {
        if (file.size > 8 * 1024 * 1024) throw new Error(file.name + ': 8MBまでです')
        toast(file.name + ' を読み取っています…')
        return new Promise(function (res, rej) { var r = new FileReader(); r.onload = function () { res(r.result) }; r.onerror = rej; r.readAsDataURL(file) })
          .then(function (dataUrl) { return api('/candidates/' + state.candidate.id + '/documents', { method: 'POST', body: { kind: kind, filename: file.name, pdfBase64: String(dataUrl).split(',')[1] } }) })
          .then(function (r) { toast(file.name + '（' + r.pages + 'ページ）を登録しました') })
      })
    })
    chain.catch(function (err) { toast(err.message, true) }).then(function () { return loadCandidate(state.candidate.id) })
  })
  $('#document-list').addEventListener('click', function (e) {
    var b = e.target.closest('.doc-delete'); if (!b) return
    if (!confirm('この書類を削除しますか？')) return
    api('/candidates/' + state.candidate.id + '/documents/' + b.getAttribute('data-id'), { method: 'DELETE' }).then(function () { return loadCandidate(state.candidate.id) }).catch(function (err) { toast(err.message, true) })
  })
  $('#profile-button').addEventListener('click', function () {
    var b = $('#profile-button'); b.disabled = true; b.innerHTML = '<i class="fas fa-spinner fa-spin mr-1"></i>読み取り中…（初回は30秒ほど）'
    api('/candidates/' + state.candidate.id + '/profile', { method: 'POST' }).then(function (r) {
      $('#profile-text').textContent = r.text; $('#profile-dialog').showModal()
    }).catch(function (err) { toast(err.message, true) }).then(function () { b.disabled = false; b.innerHTML = '<i class="fas fa-id-card mr-1"></i>読み取った経歴を見る' })
  })
  $('#referral-list').addEventListener('click', function (e) {
    var b = e.target.closest('.ref-delete'); if (!b) return
    api('/candidates/' + state.candidate.id + '/referrals?job_key=' + encodeURIComponent(b.getAttribute('data-key')), { method: 'DELETE' })
      .then(function () { return loadCandidate(state.candidate.id) }).then(renderResults).catch(function (err) { toast(err.message, true) })
  })
  $('#candidate-search-list').addEventListener('click', function (e) { var b = e.target.closest('.open-search'); if (b) openSearch(b.getAttribute('data-id'), { fill: true }) })

  // ---------------- 実行・進捗 ----------------
  form.addEventListener('submit', function (e) {
    e.preventDefault()
    var criteria = readCriteria()
    if (!criteria.freeText && !criteria.memo && !criteria.jobKeys && !(state.candidate && state.candidate.documents.length)) return toast('要望を入力するか、求職者に書類を登録してください', true)
    var btn = $('#run-button'); btn.disabled = true
    api('/searches', { method: 'POST', body: { candidateId: state.candidate ? state.candidate.id : null, criteria: criteria, options: readOptions() } })
      .then(function (r) { clearResult(); state.searchId = r.id; setUrl(); $('#result-list').innerHTML = '<p class="text-sm text-slate-400">結果はここに表示されます（数分かかります。この画面を閉じても検索は続き、あとで履歴から開けます）。</p>'; poll() })
      .catch(function (err) { toast(err.message, true); btn.disabled = false })
  })
  $('#cancel-button').addEventListener('click', function () {
    if (!state.searchId || !confirm('検索を中止しますか？（それまでに審査した結果は残ります）')) return
    api('/searches/' + state.searchId + '/cancel', { method: 'POST' }).then(function () { toast('中止を受け付けました') }).catch(function (e) { toast(e.message, true) })
  })
  function clearResult() {
    clearTimeout(state.timer); state.result = null; state.searchId = null
    $('#progress-section').classList.add('hidden'); $('#plan-section').classList.add('hidden')
    $('#recommended-count').textContent = '0'; $('#reference-count').textContent = '0'; $('#result-summary').textContent = ''
    $('#result-list').innerHTML = '<p class="text-sm text-slate-400">左で条件を入力して「AIで検索する」を押してください。</p>'
  }
  function poll() {
    clearTimeout(state.timer)
    var id = state.searchId; if (!id) return
    api('/searches/' + id).then(function (s) {
      if (id !== state.searchId) return
      renderProgress(s)
      if (s.plan) renderPlan(s.plan)
      if (['done', 'cancelled', 'error'].indexOf(s.status) >= 0) {
        $('#run-button').disabled = false
        state.result = s; renderResults()
        if (state.candidate && s.candidate_id === state.candidate.id) loadCandidate(state.candidate.id)
        return
      }
      $('#run-button').disabled = true
      if (!state.result || state.result.id !== s.id) $('#result-list').innerHTML = '<p class="text-sm text-slate-400">結果はここに表示されます（数分かかります。この画面を閉じても検索は続き、あとで履歴から開けます）。</p>'
      state.timer = setTimeout(poll, 2500)
    }).catch(function (e) { $('#progress-message').textContent = e.message; state.timer = setTimeout(poll, 5000) })
  }
  function renderProgress(s) {
    var sec = $('#progress-section'); sec.classList.remove('hidden')
    var done = ['done', 'cancelled', 'error'].indexOf(s.status) >= 0
    $('#cancel-button').classList.toggle('hidden', done)
    $('#progress-icon').className = 'fas mr-1 ' + (s.status === 'done' ? 'fa-circle-check text-emerald-600' : s.status === 'error' ? 'fa-triangle-exclamation text-red-600' : s.status === 'cancelled' ? 'fa-ban text-slate-500' : s.status === 'queued' ? 'fa-hourglass-half text-amber-500' : 'fa-spinner fa-spin text-indigo-600')
    $('#progress-title').textContent = s.status === 'queued' ? '順番待ち（' + (s.queuePosition || '?') + '番目・実行中 ' + (s.runningCount != null ? s.runningCount : '?') + '件）' : s.status === 'running' ? 'AIが検索しています' : s.status === 'done' ? '検索が終わりました' : s.status === 'cancelled' ? '中止しました' : 'エラーで止まりました'
    $('#progress-message').textContent = s.status === 'error' ? (s.error || s.message || '') : (s.message || '')
    var pct = s.status === 'queued' ? 3 : done ? 100 : (STAGE_PCT[s.stage] || 10)
    var m = /(\d[\d,]*)\s*\/\s*(\d[\d,]*)件/.exec(s.message || '')
    if (s.stage === 'screen' && m) pct = 18 + 27 * (Number(m[1].replace(/,/g, '')) / Math.max(1, Number(m[2].replace(/,/g, ''))))
    $('#progress-bar').style.width = Math.min(100, Math.round(pct)) + '%'
    var logEl = $('#progress-log'), atBottom = logEl.scrollHeight - logEl.scrollTop - logEl.clientHeight < 24
    logEl.innerHTML = (s.log || []).map(function (l) { return '<li>[' + new Date(l.t).toLocaleTimeString('ja-JP', { hour12: false }) + '] ' + esc(l.msg) + '</li>' }).join('')
    if (atBottom) logEl.scrollTop = logEl.scrollHeight  // 最新の行が見えるように（さかのぼって読んでいるときは動かさない）
  }
  function renderPlan(p) {
    $('#plan-section').classList.remove('hidden')
    $('#plan-understanding').textContent = p.understanding || ''
    $('#plan-angles').innerHTML = (p.angles || []).map(function (a) {
      var color = a.type === '王道' ? 'bg-indigo-100 text-indigo-700' : a.type === '発展' ? 'bg-emerald-100 text-emerald-700' : 'bg-amber-100 text-amber-700'
      return '<li><span class="text-[10px] rounded px-1.5 py-0.5 ' + color + '">' + esc(a.type) + '</span> <b>' + esc(a.label) + '</b> <span class="text-slate-500">' + esc(a.why || '') + '</span></li>'
    }).join('')
  }

  // ---------------- 結果 ----------------
  $$('.result-tab').forEach(function (b) {
    b.addEventListener('click', function () {
      state.tab = b.getAttribute('data-tab')
      $$('.result-tab').forEach(function (x) { x.classList.toggle('tab-active', x === b); x.classList.toggle('text-slate-500', x !== b) })
      renderResults()
    })
  })
  function referred(key) { return !!(state.candidate && state.candidate.referrals.some(function (r) { return r.job_key === key })) }
  function renderResults() {
    var s = state.result; if (!s) return
    var rec = s.recommended || [], ref = s.reference || []
    $('#recommended-count').textContent = rec.length; $('#reference-count').textContent = ref.length
    var sm = s.summary || {}
    $('#result-summary').textContent = [jst(s.created_at), s.user_name, sm.poolSize != null ? '母集団 ' + sm.poolSize.toLocaleString() + '件' : '', sm.screened != null ? '一次審査 ' + sm.screened.toLocaleString() : '', sm.elapsedSec != null ? Math.round(sm.elapsedSec / 60 * 10) / 10 + '分' : '', s.usd != null ? yen(s.usd) : ''].filter(Boolean).join(' / ')
    var list = state.tab === 'reference' ? ref : rec
    if (!list.length) {
      $('#result-list').innerHTML = '<p class="text-sm text-slate-400">' + (s.status === 'error' ? 'エラーのため結果がありません。条件を見直して、もう一度実行してください。' : state.tab === 'reference' ? '必須要件を満たさないが内容は合う求人はありませんでした。' : '条件に合う求人が見つかりませんでした。条件をゆるめてお試しください。') + '</p>'
      return
    }
    $('#result-list').innerHTML = list.map(card).join('')
  }
  function card(r, i) {
    var mark = { met: ['○', 'text-emerald-600'], unmet: ['×', 'text-red-600'], unknown: ['？', 'text-amber-600'] }
    var scoreColor = r.score >= 85 ? 'bg-emerald-600' : r.score >= 75 ? 'bg-indigo-600' : r.score >= 60 ? 'bg-slate-500' : 'bg-red-500'
    var angleColor = r.angle === '王道' ? 'bg-indigo-100 text-indigo-700' : r.angle === '発展' ? 'bg-emerald-100 text-emerald-700' : r.angle === '意外' ? 'bg-amber-100 text-amber-700' : ''
    var isRef = referred(r.key)
    return '<article class="job-result border rounded-lg p-3 ' + (isRef ? 'bg-slate-50 opacity-70' : 'hover:border-indigo-300') + '">' +
      '<div class="flex gap-3">' +
        '<div class="shrink-0 text-center"><div class="' + scoreColor + ' text-white rounded-lg w-12 h-12 flex flex-col items-center justify-center"><span class="text-lg font-bold leading-none">' + r.score + '</span><span class="text-[9px]">点</span></div>' +
          (r.capped ? '<p class="text-[9px] text-slate-400 mt-0.5" title="必須要件の判定により上限をかけました">AI ' + r.rawScore + '</p>' : '') + '</div>' +
        '<div class="min-w-0 flex-1">' +
          '<div class="flex flex-wrap items-center gap-1 text-[10px]">' + (r.angle ? '<span class="rounded px-1.5 py-0.5 ' + angleColor + '">' + esc(r.angle) + (r.angleLabel ? '：' + esc(r.angleLabel) : '') + '</span>' : '') +
            '<span class="rounded px-1.5 py-0.5 bg-slate-100">' + esc(SOURCE_LABEL[r.source] || r.source) + (r.vacancy_no ? ' ' + esc(r.vacancy_no) : '') + '</span>' +
            (r.duplicates && r.duplicates.length ? '<span class="rounded px-1.5 py-0.5 bg-slate-100" title="同じ求人がほかの媒体にもあります">ほか' + r.duplicates.map(function (d) { var w = rewardInfo(d); return esc(SOURCE_LABEL[d.key.split(':')[0]] || d.key) + (w ? '<b class="' + (w.high ? 'text-rose-600' : '') + '">（' + esc(w.short) + '）</b>' : '') }).join('・') + '</span>' : '') +
            (isRef ? '<span class="rounded px-1.5 py-0.5 bg-slate-700 text-white">紹介済み</span>' : '') + '</div>' +
          '<h3 class="font-bold leading-snug mt-1">' + (r.url ? '<a href="' + esc(r.url) + '" target="_blank" rel="noopener" class="hover:underline">' + esc(r.title) + ' <i class="fas fa-arrow-up-right-from-square text-[10px] text-slate-400"></i></a>' : esc(r.title)) + '</h3>' +
          '<p class="text-xs text-slate-600 mt-0.5">' + esc(r.company || '') + ' / ' + esc((r.locations || '').slice(0, 40)) + ' / 年収 ' + man(r.salary_min) + '〜' + man(r.salary_max) + '万' + (r.employment ? ' / ' + esc(r.employment) : '') + '</p>' +
          '<p class="mt-1 text-xs">' + rewardBadge(r) + '</p>' +
          (r.features && r.features.length ? '<p class="mt-1 flex flex-wrap gap-1">' + r.features.map(function (f) { return '<span class="text-[10px] bg-sky-50 text-sky-700 rounded px-1.5">' + esc(FEATURE_LABEL[f] || f) + '</span>' }).join('') + '</p>' : '') +
          '<p class="text-sm mt-2 leading-relaxed">' + esc(r.reason || r.fit) + '</p>' +
          (r.must && r.must.length ? '<ul class="mt-2 text-xs space-y-0.5">' + r.must.map(function (m) { var k = mark[m.status] || mark.unknown; return '<li><b class="' + k[1] + '">' + k[0] + '</b> ' + esc(m.req) + (m.evidence ? ' <span class="text-slate-400">… ' + esc(m.evidence) + '</span>' : '') + '</li>' }).join('') + '</ul>' : '') +
          (r.concerns && r.concerns.length ? '<p class="text-xs mt-1 text-amber-700"><i class="fas fa-triangle-exclamation mr-1"></i>' + r.concerns.map(esc).join(' / ') + '</p>' : '') +
          (r.checkPoints && r.checkPoints.length ? '<p class="text-xs mt-1 text-slate-600"><i class="fas fa-circle-question mr-1"></i>応募前の確認: ' + r.checkPoints.map(esc).join(' / ') + '</p>' : '') +
          '<div class="mt-2 flex flex-wrap gap-2 text-xs">' +
            (state.candidate ? '<button class="mark-referral border rounded px-2 py-1 ' + (isRef ? 'bg-slate-700 text-white' : 'hover:bg-slate-50') + '" data-i="' + i + '">' + (isRef ? '<i class="fas fa-check mr-1"></i>紹介済み（取り消す）' : '<i class="fas fa-paper-plane mr-1"></i>紹介済みにする') + '</button>' : '') +
            '<a class="border rounded px-2 py-1 hover:bg-slate-50" href="/manual?keyword=' + encodeURIComponent((r.company || '').slice(0, 20)) + '" target="_blank" rel="noopener"><i class="fas fa-building mr-1"></i>同じ会社の求人</a>' +
            '<button class="copy-job border rounded px-2 py-1 hover:bg-slate-50" data-i="' + i + '"><i class="fas fa-copy mr-1"></i>コピー</button>' +
          '</div>' +
        '</div></div></article>'
  }
  $('#result-list').addEventListener('click', function (e) {
    var s = state.result; if (!s) return
    var list = state.tab === 'reference' ? s.reference : s.recommended
    var b = e.target.closest('.mark-referral')
    if (b) {
      var r = list[Number(b.getAttribute('data-i'))]; if (!r || !state.candidate) return
      var p = referred(r.key)
        ? api('/candidates/' + state.candidate.id + '/referrals?job_key=' + encodeURIComponent(r.key), { method: 'DELETE' })
        : api('/candidates/' + state.candidate.id + '/referrals', { method: 'POST', body: { job_key: r.key, title: r.title, company: r.company, search_id: s.id } })
      p.then(function () { return loadCandidate(state.candidate.id) }).then(renderResults).catch(function (err) { toast(err.message, true) })
      return
    }
    var c = e.target.closest('.copy-job')
    if (c) {
      var x = list[Number(c.getAttribute('data-i'))]
      var text = '【' + x.title + '】' + (x.company || '') + '\n勤務地: ' + (x.locations || '') + ' / 年収: ' + man(x.salary_min) + '〜' + man(x.salary_max) + '万円\n' + (x.reason || '') + (x.url ? '\n' + x.url : '')
      navigator.clipboard.writeText(text).then(function () { toast('コピーしました') }, function () { toast('コピーできませんでした', true) })
    }
  })

  function openSearch(id, opts) {
    state.searchId = id; setUrl()
    api('/searches/' + id).then(function (s) {
      if (opts && opts.fill) { fillCriteria(s.criteria, s.options); state.jobKeys = s.criteria.jobKeys || []; renderJobKeys() }
      if (s.candidate_id && (!state.candidate || state.candidate.id !== s.candidate_id)) loadCandidate(s.candidate_id).catch(function () {})
      renderProgress(s); if (s.plan) renderPlan(s.plan)
      state.result = s
      if (['done', 'cancelled', 'error'].indexOf(s.status) >= 0) renderResults(); else poll()
    }).catch(function (e) { toast(e.message, true) })
  }

  // ---------------- 履歴（全体） ----------------
  var hDlg = $('#history-dialog')
  function loadHistory() {
    api('/searches?limit=100' + ($('#history-mine').checked ? '&mine=1' : '')).then(function (d) {
      $('#history-list').innerHTML = d.items.length ? d.items.map(function (s) {
        return '<li><button class="open-history w-full text-left py-2 px-1 hover:bg-indigo-50 rounded" data-id="' + esc(s.id) + '">' +
          '<span class="text-xs text-slate-500">' + jst(s.created_at) + '</span> ' + statusBadge(s.status) + ' <span class="text-xs">' + esc(s.candidate_name ? s.candidate_name + '（No.' + s.candidate_id + '）' : '求職者の登録なし') + '</span>' +
          ' <span class="text-xs text-slate-400">担当 ' + esc(s.user_name || '-') + (s.recommended != null ? ' / 提案 ' + s.recommended + '件' : '') + (s.usd != null ? ' / ' + yen(s.usd) : '') + '</span>' +
          '<span class="block text-sm truncate">' + esc(s.freeText || '（要望なし）') + '</span></button></li>'
      }).join('') : '<li class="text-sm text-slate-400 py-4 text-center">まだ履歴はありません</li>'
    }).catch(function (e) { toast(e.message, true) })
  }
  $('#history-button').addEventListener('click', function () { hDlg.showModal(); loadHistory() })
  $('#history-mine').addEventListener('change', loadHistory)
  $('#history-list').addEventListener('click', function (e) {
    var b = e.target.closest('.open-history'); if (!b) return
    hDlg.close()
    openSearch(b.getAttribute('data-id'), { fill: true })
  })

  $$('.dialog-close').forEach(function (b) { b.addEventListener('click', function () { b.closest('dialog').close() }) })
  $$('dialog').forEach(function (d) { d.addEventListener('click', function (e) { if (e.target === d) d.close() }) })

  // ---------------- 起動時: URL から復元（再読み込み・共有・手動検索からの受け渡し） ----------------
  var init = new URLSearchParams(location.search)
  if (init.get('jobKeys')) { state.jobKeys = init.get('jobKeys').split(',').filter(Boolean).slice(0, 5000); renderJobKeys() }
  var start = Promise.resolve()
  if (init.get('candidate')) start = loadCandidate(init.get('candidate'), { fill: !init.get('search') }).catch(function () {})
  start.then(function () { if (init.get('search')) openSearch(init.get('search'), { fill: true }) })
})()
