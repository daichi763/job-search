// ログイン画面・担当者の管理画面・自分のアカウント画面
const esc = (s: unknown) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!))

const head = (title: string) => `<!DOCTYPE html>
<html lang="ja">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${esc(title)}｜求人横断検索AI</title>
  <link rel="icon" type="image/svg+xml" href="/favicon.svg">
  <script src="https://cdn.tailwindcss.com"></script>
  <link href="https://cdn.jsdelivr.net/npm/@fortawesome/fontawesome-free@6.4.0/css/all.min.css" rel="stylesheet">
</head>`

export function renderLoginPage(next: string): string {
  return `${head('ログイン')}
<body class="bg-slate-50 text-slate-800 min-h-screen flex items-center justify-center p-4">
  <main id="login-section" class="w-full max-w-sm bg-white rounded-xl shadow p-6">
    <h1 class="text-xl font-bold mb-1"><i class="fas fa-magnifying-glass-chart mr-2 text-indigo-600"></i>求人横断検索AI</h1>
    <p class="text-sm text-slate-500 mb-5">担当者アカウントでログインしてください</p>
    <form id="login-form" class="space-y-4" data-next="${esc(next)}">
      <label class="block text-sm">メールアドレス
        <input id="login-id-input" name="login_id" type="email" autocomplete="username" required class="mt-1 w-full border rounded px-3 py-2">
      </label>
      <label class="block text-sm">パスワード
        <input id="password-input" name="password" type="password" autocomplete="current-password" required class="mt-1 w-full border rounded px-3 py-2">
      </label>
      <p id="login-error" class="hidden text-sm text-red-600"></p>
      <button id="login-button" type="submit" class="w-full bg-indigo-600 hover:bg-indigo-700 text-white font-semibold rounded py-2">ログイン</button>
    </form>
    <p class="text-xs text-slate-400 mt-5">パスワードを忘れた場合は、管理者に再設定を依頼してください。</p>
  </main>
  <script src="/static/auth.js"></script>
</body></html>`
}

const nav = (me: { name: string; role: string }, active: string) => `
  <header class="bg-gradient-to-r from-indigo-600 to-blue-600 text-white shadow">
    <nav class="max-w-5xl mx-auto px-4 py-3 flex flex-wrap items-center gap-3">
      <a href="/" class="font-bold mr-auto"><i class="fas fa-magnifying-glass-chart mr-2"></i>求人横断検索AI</a>
      <a href="/ai" class="text-sm hover:underline">AI検索</a>
      <a href="/manual" class="text-sm hover:underline">手動検索</a>
      ${me.role === 'admin' ? `<a href="/admin/users" class="text-sm ${active === 'users' ? 'underline font-semibold' : 'hover:underline'}">担当者の管理</a>` : ''}
      <a href="/account" class="text-sm ${active === 'account' ? 'underline font-semibold' : 'hover:underline'}"><i class="fas fa-user mr-1"></i>${esc(me.name)}</a>
      <button class="logout-button text-sm bg-white/20 hover:bg-white/30 rounded-full px-3 py-1">ログアウト</button>
    </nav>
  </header>`

export function renderUsersPage(me: { id: number; name: string; role: string }): string {
  return `${head('担当者の管理')}
<body class="bg-slate-50 text-slate-800 min-h-screen" data-me="${me.id}">
  ${nav(me, 'users')}
  <main class="max-w-5xl mx-auto px-4 py-6 space-y-6">
    <section id="user-list-section" class="bg-white rounded-xl shadow p-5">
      <div class="flex items-center justify-between mb-3">
        <h1 class="text-lg font-bold">担当者の一覧</h1>
        <button id="add-user-button" class="text-sm bg-indigo-600 hover:bg-indigo-700 text-white rounded px-3 py-1.5"><i class="fas fa-plus mr-1"></i>担当者を追加</button>
      </div>
      <p class="text-xs text-slate-500 mb-3">ログインした担当者の名前が、検索の担当者として記録されます。<b>管理者</b>はこの画面で担当者を追加・変更・無効化できます。退職などで使わなくなった担当者は「無効」にすると、過去の検索履歴の名前は残したままログインできなくなります。</p>
      <div class="overflow-x-auto">
        <table id="user-table" class="w-full text-sm">
          <thead class="text-left text-slate-500 border-b">
            <tr><th class="py-2 pr-3">名前</th><th class="pr-3">メールアドレス（ログインID）</th><th class="pr-3">権限</th><th class="pr-3">状態</th><th class="pr-3">最終ログイン（日本時間）</th><th></th></tr>
          </thead>
          <tbody id="user-rows"><tr><td colspan="6" class="py-4 text-slate-400">読み込み中…</td></tr></tbody>
        </table>
      </div>
    </section>
  </main>

  <dialog id="user-dialog" class="rounded-xl shadow-xl p-0 w-full max-w-md backdrop:bg-black/40">
    <form id="user-form" method="dialog" class="p-5 space-y-3">
      <h2 id="user-dialog-title" class="text-lg font-bold">担当者を追加</h2>
      <input type="hidden" name="id">
      <label class="block text-sm">名前（表示名）
        <input name="name" required maxlength="50" class="mt-1 w-full border rounded px-3 py-2" placeholder="例: 山田 太郎">
      </label>
      <label class="block text-sm">メールアドレス（ログインID）
        <input name="login_id" type="email" required class="mt-1 w-full border rounded px-3 py-2">
      </label>
      <label class="block text-sm">権限
        <select name="role" class="mt-1 w-full border rounded px-3 py-2">
          <option value="staff">担当者（検索のみ）</option>
          <option value="admin">管理者（担当者の管理もできる）</option>
        </select>
      </label>
      <label class="block text-sm"><span id="password-label">パスワード（8文字以上）</span>
        <input name="password" type="text" autocomplete="new-password" class="mt-1 w-full border rounded px-3 py-2">
      </label>
      <p id="user-form-error" class="hidden text-sm text-red-600"></p>
      <div class="flex justify-end gap-2 pt-2">
        <button type="button" id="user-cancel-button" class="text-sm border rounded px-3 py-1.5">キャンセル</button>
        <button type="submit" id="user-save-button" class="text-sm bg-indigo-600 hover:bg-indigo-700 text-white rounded px-3 py-1.5">保存</button>
      </div>
    </form>
  </dialog>
  <script src="/static/auth.js"></script>
</body></html>`
}

export function renderAccountPage(me: { id: number; name: string; role: string; login_id: string }): string {
  return `${head('アカウント')}
<body class="bg-slate-50 text-slate-800 min-h-screen">
  ${nav(me, 'account')}
  <main class="max-w-md mx-auto px-4 py-6 space-y-6">
    <section id="account-section" class="bg-white rounded-xl shadow p-5">
      <h1 class="text-lg font-bold mb-3">アカウント</h1>
      <dl class="text-sm grid grid-cols-[8rem_1fr] gap-y-1">
        <dt class="text-slate-500">名前</dt><dd>${esc(me.name)}</dd>
        <dt class="text-slate-500">メールアドレス</dt><dd>${esc(me.login_id)}</dd>
        <dt class="text-slate-500">権限</dt><dd>${me.role === 'admin' ? '管理者' : '担当者'}</dd>
      </dl>
    </section>
    <section id="password-section" class="bg-white rounded-xl shadow p-5">
      <h2 class="font-bold mb-3">パスワードの変更</h2>
      <form id="password-form" class="space-y-3">
        <label class="block text-sm">現在のパスワード
          <input name="current" type="password" autocomplete="current-password" required class="mt-1 w-full border rounded px-3 py-2">
        </label>
        <label class="block text-sm">新しいパスワード（8文字以上）
          <input name="next" type="password" autocomplete="new-password" required minlength="8" class="mt-1 w-full border rounded px-3 py-2">
        </label>
        <label class="block text-sm">新しいパスワード（確認）
          <input name="confirm" type="password" autocomplete="new-password" required minlength="8" class="mt-1 w-full border rounded px-3 py-2">
        </label>
        <p id="password-message" class="hidden text-sm"></p>
        <button type="submit" class="bg-indigo-600 hover:bg-indigo-700 text-white text-sm rounded px-3 py-1.5">変更する</button>
      </form>
    </section>
  </main>
  <script src="/static/auth.js"></script>
</body></html>`
}

// 既存画面（AI検索・手動検索）に差し込む、ログイン中の担当者の表示
export function userBadge(me: { name: string; role: string }): string {
  return `<div id="user-badge" style="position:fixed;right:12px;bottom:12px;z-index:50" class="flex items-center gap-2 bg-white/95 border border-slate-200 shadow rounded-full pl-3 pr-1 py-1 text-xs text-slate-700">
  <a href="/account" title="アカウント"><i class="fas fa-user mr-1 text-indigo-600"></i>${esc(me.name)}</a>
  ${me.role === 'admin' ? '<a href="/admin/users" class="text-indigo-700 hover:underline">担当者の管理</a>' : ''}
  <button class="logout-button bg-slate-100 hover:bg-slate-200 rounded-full px-2 py-0.5">ログアウト</button>
</div><script src="/static/auth.js"></script>`
}
