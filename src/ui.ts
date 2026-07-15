// フロントUI（単一HTML + Tailwind CDN + バニラJS）

export function renderPage(): string {
  return `<!DOCTYPE html>
<html lang="ja">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>求人横断検索AI</title>
  <link rel="icon" href="/favicon.ico">
  <script src="https://cdn.tailwindcss.com"></script>
  <link href="https://cdn.jsdelivr.net/npm/@fortawesome/fontawesome-free@6.4.0/css/all.min.css" rel="stylesheet">
  <style>
    .worker-card { transition: all .3s ease; }
    .pulse-dot { animation: pulse 1.2s infinite; }
    @keyframes pulse { 0%,100%{opacity:1} 50%{opacity:.3} }
    .result-in { animation: slideIn .4s ease; }
    @keyframes slideIn { from{opacity:0;transform:translateY(10px)} to{opacity:1;transform:translateY(0)} }
    .score-ring { background: conic-gradient(var(--c) calc(var(--p)*1%), #e5e7eb 0); }
  </style>
</head>
<body class="bg-slate-50 text-slate-800 min-h-screen">
  <header class="bg-gradient-to-r from-indigo-600 to-blue-600 text-white shadow">
    <div class="max-w-6xl mx-auto px-4 py-4 flex items-center justify-between">
      <h1 class="text-xl font-bold"><i class="fas fa-magnifying-glass-chart mr-2"></i>求人横断検索AI</h1>
      <div id="grand-total" class="text-sm bg-white/20 rounded-full px-4 py-1.5">
        <i class="fas fa-database mr-1"></i>総求人数: <span id="grand-total-num" class="font-bold">…</span> 件
      </div>
    </div>
  </header>

  <main class="max-w-6xl mx-auto px-4 py-6 grid grid-cols-1 lg:grid-cols-5 gap-6">
    <!-- 左: 検索条件 -->
    <section id="search-panel" class="lg:col-span-2 space-y-4">
      <div class="bg-white rounded-xl shadow-sm border border-slate-200 p-5">
        <h2 class="font-bold text-slate-700 mb-3"><i class="fas fa-sliders mr-2 text-indigo-500"></i>検索条件</h2>

        <label class="block text-sm font-semibold mb-1">要望（フリー記述）<span class="text-xs text-indigo-500 font-normal">※AIが最重視</span></label>
        <textarea id="freeText" rows="4" class="w-full border border-slate-300 rounded-lg p-2 text-sm mb-3"
          placeholder="例）風通しの良い風土で、裁量を持って若手のうちから成長できる環境。マネジメントより現場志向。転勤は避けたい。"></textarea>

        <div class="grid grid-cols-2 gap-3 mb-3">
          <div>
            <label class="block text-sm font-semibold mb-1">希望年収 下限</label>
            <div class="flex items-center gap-1">
              <input id="salaryMin" type="number" class="w-full border border-slate-300 rounded-lg p-2 text-sm" placeholder="400">
              <span class="text-xs text-slate-500">万円</span>
            </div>
          </div>
          <div>
            <label class="block text-sm font-semibold mb-1">払い出し件数</label>
            <input id="topN" type="number" value="10" min="1" max="50" class="w-full border border-slate-300 rounded-lg p-2 text-sm">
          </div>
        </div>

        <label class="block text-sm font-semibold mb-1">勤務地（都道府県）</label>
        <div id="locations" class="flex flex-wrap gap-1 mb-3 max-h-28 overflow-y-auto border border-slate-100 rounded-lg p-2"></div>

        <label class="block text-sm font-semibold mb-1">雇用形態</label>
        <div id="employment" class="flex flex-wrap gap-1 mb-3"></div>

        <label class="block text-sm font-semibold mb-1">職種（大分類）</label>
        <select id="jobCategories" multiple size="4" class="w-full border border-slate-300 rounded-lg p-2 text-sm mb-3"></select>

        <label class="block text-sm font-semibold mb-1">残業（許容上限）</label>
        <select id="overtimeMax" class="w-full border border-slate-300 rounded-lg p-2 text-sm mb-3">
          <option value="">指定なし</option>
          <option value="残業なし">残業なし</option>
          <option value="10時間以下">10時間以下</option>
          <option value="20時間以下">20時間以下</option>
          <option value="30時間以下">30時間以下</option>
          <option value="40時間以下">40時間以下</option>
        </select>

        <label class="block text-sm font-semibold mb-1">休日</label>
        <div id="holiday" class="flex flex-wrap gap-1 mb-3"></div>

        <label class="block text-sm font-semibold mb-1">検索対象DB</label>
        <div id="sources" class="flex flex-wrap gap-2 mb-4"></div>

        <button id="searchBtn" class="w-full bg-indigo-600 hover:bg-indigo-700 text-white font-bold py-2.5 rounded-lg transition">
          <i class="fas fa-robot mr-2"></i>AIスタッフに探してもらう
        </button>
      </div>
    </section>

    <!-- 右: AI担当状態 + 結果 -->
    <section class="lg:col-span-3 space-y-4">
      <!-- AI担当ダッシュボード -->
      <div class="bg-white rounded-xl shadow-sm border border-slate-200 p-5">
        <h2 class="font-bold text-slate-700 mb-3"><i class="fas fa-people-group mr-2 text-indigo-500"></i>AIスタッフ稼働状況</h2>
        <div id="workers" class="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <p class="text-sm text-slate-400 col-span-2">検索を開始すると各DB担当が稼働します。</p>
        </div>
      </div>

      <!-- 結果 -->
      <div class="bg-white rounded-xl shadow-sm border border-slate-200 p-5">
        <div class="flex items-center justify-between mb-3">
          <h2 class="font-bold text-slate-700"><i class="fas fa-list-check mr-2 text-indigo-500"></i>マッチした求人 <span id="result-count" class="text-indigo-600">(0)</span></h2>
          <span id="search-status" class="text-xs text-slate-400"></span>
        </div>
        <div id="results" class="space-y-3">
          <p class="text-sm text-slate-400">まだ結果はありません。</p>
        </div>
      </div>
    </section>
  </main>

  <script src="/static/app.js"></script>
</body>
</html>`
}
