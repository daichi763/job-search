// 手動検索モード ページ（自社DB内を直接検索）
//   AI検索(renderPage)とは完全に独立した別ページ。
//   /api/manual/jobs, /api/manual/facets, /api/trace/* を使う。

export function renderManualPage(): string {
  return `<!DOCTYPE html>
<html lang="ja">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>手動検索モード｜求人横断検索AI</title>
  <link rel="icon" type="image/svg+xml" href="/favicon.svg">
  <link rel="alternate icon" href="/favicon.ico">
  <script src="https://cdn.tailwindcss.com"></script>
  <link href="https://cdn.jsdelivr.net/npm/@fortawesome/fontawesome-free@6.4.0/css/all.min.css" rel="stylesheet">
  <style>
    .job-card { transition: box-shadow .2s ease, transform .2s ease; }
    .job-card:hover { box-shadow: 0 8px 24px rgba(0,0,0,.08); transform: translateY(-1px); }
    .src-badge { font-size: 11px; padding: 2px 8px; border-radius: 999px; font-weight: 600; }
    .src-circus  { background:#e0e7ff; color:#3730a3; }
    .src-hitolink{ background:#dcfce7; color:#166534; }
    .src-jobins  { background:#fef3c7; color:#92400e; }
    .src-kintone { background:#fce7f3; color:#9d174d; }
    .spin { animation: spin 1s linear infinite; } @keyframes spin { to { transform: rotate(360deg) } }
  </style>
</head>
<body class="bg-gray-50 min-h-screen text-gray-800">
  <header class="bg-gradient-to-r from-emerald-600 to-teal-600 text-white shadow">
    <div class="max-w-7xl mx-auto px-4 py-4 flex items-center justify-between">
      <h1 class="text-xl font-bold"><i class="fas fa-sliders mr-2"></i>手動検索モード<span class="text-sm font-normal opacity-80 ml-2">自社DBを直接検索</span></h1>
      <div class="flex items-center gap-3">
        <button id="syncBtn" class="text-sm bg-white text-emerald-700 hover:bg-emerald-50 font-semibold rounded-full px-4 py-1.5 transition shadow-sm">
          <i class="fas fa-rotate mr-1"></i>今すぐ全件同期
        </button>
        <a href="/" class="text-sm bg-white/20 hover:bg-white/30 rounded-full px-4 py-1.5 transition">
          <i class="fas fa-robot mr-1"></i>AI検索に戻る
        </a>
      </div>
    </div>
  </header>

  <!-- 同期ステータスバー（同期中のみ表示） -->
  <section id="syncBar" class="hidden bg-emerald-50 border-b border-emerald-200">
    <div class="max-w-7xl mx-auto px-4 py-2 text-sm text-emerald-800 flex items-center gap-3 flex-wrap">
      <span><i class="fas fa-circle-notch spin mr-1"></i><span id="syncSummary">同期中…</span></span>
      <span id="syncStates" class="flex gap-2 flex-wrap"></span>
    </div>
  </section>

  <main class="max-w-7xl mx-auto px-4 py-6 grid grid-cols-1 lg:grid-cols-4 gap-6">
    <!-- 絞り込みパネル -->
    <aside class="lg:col-span-1">
      <div class="bg-white rounded-2xl shadow p-5 sticky top-4">
        <h2 class="font-bold text-gray-700 mb-4"><i class="fas fa-filter mr-1 text-emerald-600"></i>絞り込み</h2>

        <label class="block text-xs font-semibold text-gray-500 mb-1">キーワード</label>
        <input id="f-keyword" type="text" placeholder="タイトル・企業・仕事内容など" class="w-full border rounded-lg px-3 py-2 text-sm mb-3 focus:ring-2 focus:ring-emerald-400 outline-none">

        <label class="block text-xs font-semibold text-gray-500 mb-1">媒体</label>
        <select id="f-source" class="w-full border rounded-lg px-3 py-2 text-sm mb-3 bg-white"><option value="">すべて</option></select>

        <label class="block text-xs font-semibold text-gray-500 mb-1">職種</label>
        <input id="f-category" list="dl-category" type="text" placeholder="例: 営業 / エンジニア" class="w-full border rounded-lg px-3 py-2 text-sm mb-1">
        <datalist id="dl-category"></datalist>
        <div class="mb-3"></div>

        <label class="block text-xs font-semibold text-gray-500 mb-1">業種</label>
        <input id="f-industry" list="dl-industry" type="text" placeholder="例: IT / 製造" class="w-full border rounded-lg px-3 py-2 text-sm mb-1">
        <datalist id="dl-industry"></datalist>
        <div class="mb-3"></div>

        <label class="block text-xs font-semibold text-gray-500 mb-1">雇用形態</label>
        <input id="f-employment" list="dl-employment" type="text" placeholder="例: 正社員" class="w-full border rounded-lg px-3 py-2 text-sm mb-1">
        <datalist id="dl-employment"></datalist>
        <div class="mb-3"></div>

        <label class="block text-xs font-semibold text-gray-500 mb-1">勤務地</label>
        <input id="f-location" type="text" placeholder="例: 東京 / 大阪" class="w-full border rounded-lg px-3 py-2 text-sm mb-3">

        <label class="block text-xs font-semibold text-gray-500 mb-1">想定年収（万円）</label>
        <div class="flex items-center gap-2 mb-3">
          <input id="f-salaryMin" type="number" placeholder="下限" class="w-full border rounded-lg px-2 py-2 text-sm">
          <span class="text-gray-400">〜</span>
          <input id="f-salaryMax" type="number" placeholder="上限" class="w-full border rounded-lg px-2 py-2 text-sm">
        </div>

        <label class="flex items-center gap-2 text-sm mb-4 cursor-pointer">
          <input id="f-openOnly" type="checkbox" checked class="rounded text-emerald-600 focus:ring-emerald-400">
          <span>掲載中のみ表示</span>
        </label>

        <button id="searchBtn" class="w-full bg-emerald-600 hover:bg-emerald-700 text-white font-semibold rounded-lg py-2.5 transition">
          <i class="fas fa-magnifying-glass mr-1"></i>検索
        </button>
        <button id="resetBtn" class="w-full mt-2 text-sm text-gray-500 hover:text-gray-700 py-1">条件をクリア</button>
      </div>
    </aside>

    <!-- 結果一覧 -->
    <section class="lg:col-span-3">
      <div class="flex items-center justify-between mb-3 flex-wrap gap-2">
        <div class="text-sm text-gray-600"><span id="resultCount" class="font-bold text-gray-800">0</span> 件</div>
        <div class="flex items-center gap-2 text-sm">
          <label class="text-gray-500">並び順</label>
          <select id="f-sort" class="border rounded-lg px-2 py-1.5 bg-white">
            <option value="updated">更新が新しい順</option>
            <option value="new">登録が新しい順</option>
            <option value="salary_desc">年収が高い順</option>
            <option value="salary_asc">年収が低い順</option>
          </select>
        </div>
      </div>

      <div id="results" class="space-y-3"></div>

      <div id="pager" class="flex items-center justify-center gap-2 mt-6"></div>
      <div id="emptyState" class="hidden text-center text-gray-400 py-20">
        <i class="fas fa-inbox text-5xl mb-3"></i>
        <p>該当する求人がありません。条件を変えるか「今すぐ全件同期」でDBを更新してください。</p>
      </div>
    </section>
  </main>

  <script src="/static/manual.js"></script>
</body>
</html>`
}
