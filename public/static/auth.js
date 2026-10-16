// ログイン・ログアウト・担当者の管理・パスワード変更（画面にある要素だけ動かす）
(function () {
  function $(s, el) { return (el || document).querySelector(s) }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] }) }
  function api(path, opts) {
    opts = opts || {}
    return fetch(path, {
      method: opts.method || 'GET', credentials: 'same-origin',
      headers: opts.body ? { 'Content-Type': 'application/json' } : {},
      body: opts.body ? JSON.stringify(opts.body) : undefined,
    }).then(function (r) { return r.json().catch(function () { return {} }).then(function (d) { d._status = r.status; return d }) })
  }
  function show(el, text, ok) { el.textContent = text; el.classList.remove('hidden', 'text-red-600', 'text-emerald-700'); el.classList.add(ok ? 'text-emerald-700' : 'text-red-600') }

  // ログアウト（どの画面でも）
  document.addEventListener('click', function (e) {
    var b = e.target.closest && e.target.closest('.logout-button')
    if (!b) return
    api('/api/auth/logout', { method: 'POST' }).then(function () { location.href = '/login' })
  })
  if (window.__authLoaded) return
  window.__authLoaded = true

  // ログイン画面
  var lf = $('#login-form')
  if (lf) {
    lf.addEventListener('submit', function (e) {
      e.preventDefault()
      var btn = $('#login-button'); btn.disabled = true; btn.textContent = 'ログイン中…'
      api('/api/auth/login', { method: 'POST', body: { login_id: lf.login_id.value, password: lf.password.value } }).then(function (d) {
        if (d.ok) { var n = lf.getAttribute('data-next') || '/'; location.href = /^\/(?!\/)/.test(n) ? n : '/'; return }
        show($('#login-error'), d.error || 'ログインできませんでした')
        btn.disabled = false; btn.textContent = 'ログイン'
      })
    })
  }

  // パスワード変更
  var pf = $('#password-form')
  if (pf) {
    pf.addEventListener('submit', function (e) {
      e.preventDefault()
      var msg = $('#password-message')
      if (pf.next.value !== pf.confirm.value) return show(msg, '新しいパスワードが確認用と一致しません')
      api('/api/auth/password', { method: 'POST', body: { current: pf.current.value, next: pf.next.value } }).then(function (d) {
        if (d.ok) { pf.reset(); show(msg, 'パスワードを変更しました', true) } else show(msg, d.error || '変更できませんでした')
      })
    })
  }

  // 担当者の管理
  var rows = $('#user-rows')
  if (rows) {
    var me = Number(document.body.getAttribute('data-me'))
    var dlg = $('#user-dialog'), form = $('#user-form'), users = []
    // DBの時刻は世界標準時（UTC）。日本時間に直して秒まで表示する
    var fmt = function (s) {
      if (!s) return '—'
      var d = new Date(String(s).replace(' ', 'T') + (/[zZ]|[+-]\d\d:?\d\d$/.test(s) ? '' : 'Z'))
      if (isNaN(d)) return esc(s)
      var j = new Date(d.getTime() + 9 * 3600 * 1000), p = function (n) { return String(n).padStart(2, '0') }
      return j.getUTCFullYear() + '-' + p(j.getUTCMonth() + 1) + '-' + p(j.getUTCDate()) + ' ' + p(j.getUTCHours()) + ':' + p(j.getUTCMinutes()) + ':' + p(j.getUTCSeconds())
    }
    function load() {
      api('/api/admin/users').then(function (d) {
        users = d.users || []
        rows.innerHTML = users.map(function (u) {
          return '<tr class="border-b last:border-0 ' + (u.active ? '' : 'text-slate-400') + '">' +
            '<td class="py-2 pr-3 font-medium">' + esc(u.name) + (u.id === me ? ' <span class="text-xs text-indigo-600">（自分）</span>' : '') + '</td>' +
            '<td class="pr-3">' + esc(u.login_id) + '</td>' +
            '<td class="pr-3">' + (u.role === 'admin' ? '<span class="text-xs bg-indigo-100 text-indigo-700 rounded px-2 py-0.5">管理者</span>' : '担当者') + '</td>' +
            '<td class="pr-3">' + (u.active ? '有効' : '<span class="text-xs bg-slate-100 rounded px-2 py-0.5">無効</span>') + '</td>' +
            '<td class="pr-3 text-xs">' + fmt(u.last_login_at) + '</td>' +
            '<td class="text-right whitespace-nowrap">' +
              '<button class="edit-user text-xs border rounded px-2 py-1 mr-1" data-id="' + u.id + '">編集</button>' +
              (u.id === me ? '' : '<button class="toggle-user text-xs border rounded px-2 py-1 mr-1" data-id="' + u.id + '">' + (u.active ? '無効にする' : '有効にする') + '</button>' +
              '<button class="delete-user text-xs border border-red-200 text-red-600 rounded px-2 py-1" data-id="' + u.id + '">削除</button>') +
            '</td></tr>'
        }).join('') || '<tr><td colspan="6" class="py-4 text-slate-400">担当者がいません</td></tr>'
      })
    }
    function open(u) {
      form.reset(); $('#user-form-error').classList.add('hidden')
      form.id.value = u ? u.id : ''
      form.name.value = u ? u.name : ''
      form.login_id.value = u ? u.login_id : ''
      form.role.value = u ? u.role : 'staff'
      form.password.required = !u
      $('#user-dialog-title').textContent = u ? '担当者を編集' : '担当者を追加'
      $('#password-label').textContent = u ? '新しいパスワード（変更する場合だけ・8文字以上）' : 'パスワード（8文字以上）'
      dlg.showModal()
    }
    $('#add-user-button').addEventListener('click', function () { open(null) })
    $('#user-cancel-button').addEventListener('click', function () { dlg.close() })
    form.addEventListener('submit', function (e) {
      e.preventDefault()
      var id = form.id.value
      var body = { name: form.name.value, login_id: form.login_id.value, role: form.role.value }
      if (form.password.value) body.password = form.password.value
      api(id ? '/api/admin/users/' + id : '/api/admin/users', { method: id ? 'PATCH' : 'POST', body: body }).then(function (d) {
        if (d.ok) { dlg.close(); load() } else show($('#user-form-error'), d.error || '保存できませんでした')
      })
    })
    rows.addEventListener('click', function (e) {
      var b = e.target.closest('button'); if (!b) return
      var u = users.find(function (x) { return String(x.id) === b.getAttribute('data-id') }); if (!u) return
      if (b.classList.contains('edit-user')) return open(u)
      if (b.classList.contains('toggle-user')) {
        if (u.active && !confirm(u.name + ' さんを無効にします（ログインできなくなります）。よろしいですか？')) return
        api('/api/admin/users/' + u.id, { method: 'PATCH', body: { active: !u.active } }).then(function (d) { if (!d.ok) alert(d.error); load() })
      }
      if (b.classList.contains('delete-user')) {
        if (!confirm(u.name + ' さんを削除します。元に戻せません（過去の検索履歴の担当者名は残ります）。よろしいですか？')) return
        api('/api/admin/users/' + u.id, { method: 'DELETE' }).then(function (d) { if (!d.ok) alert(d.error); load() })
      }
    })
    load()
  }
})()
