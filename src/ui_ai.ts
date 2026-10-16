// 新しいAI検索（求人DB方式）の画面: 求職者の選択 → 書類・要望・条件 → 実行 → 結果（紹介済みの記録）・履歴
const esc = (s: unknown) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!))

const PREFS = ['北海道', '青森県', '岩手県', '宮城県', '秋田県', '山形県', '福島県', '茨城県', '栃木県', '群馬県', '埼玉県', '千葉県', '東京都', '神奈川県', '新潟県', '富山県', '石川県', '福井県', '山梨県', '長野県', '岐阜県', '静岡県', '愛知県', '三重県', '滋賀県', '京都府', '大阪府', '兵庫県', '奈良県', '和歌山県', '鳥取県', '島根県', '岡山県', '広島県', '山口県', '徳島県', '香川県', '愛媛県', '高知県', '福岡県', '佐賀県', '長崎県', '熊本県', '大分県', '宮崎県', '鹿児島県', '沖縄県']
const FEATURES: [string, string][] = [['remote', 'リモート可'], ['flex', 'フレックス'], ['no_transfer', '転勤なし'], ['weekend_off', '土日祝休み'], ['holidays_120', '年間休日120日以上'], ['side_job', '副業可'], ['inexperienced_ok', '未経験可'], ['short_time', '時短勤務可']]
const EMPLOYMENT = ['正社員', '契約社員', '派遣', '業務委託', 'アルバイト']
const SOURCES: [string, string][] = [['circus', 'circus'], ['hitolink', 'ヒトリンク'], ['jobins', 'ジョビンズ'], ['kintone', 'kintone']]

const chips = (name: string, items: [string, string][]) => items.map(([v, l]) =>
  `<label class="chip"><input type="checkbox" name="${name}" value="${esc(v)}"><span>${esc(l)}</span></label>`).join('')

export function renderAiPage(me: { id: number; name: string; role: string }): string {
  return `<!DOCTYPE html>
<html lang="ja">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>AI検索｜求人横断検索AI</title>
  <link rel="icon" type="image/svg+xml" href="/favicon.svg">
  <script src="https://cdn.tailwindcss.com"></script>
  <link href="https://cdn.jsdelivr.net/npm/@fortawesome/fontawesome-free@6.4.0/css/all.min.css" rel="stylesheet">
  <style>
    .chip { display:inline-flex; cursor:pointer; user-select:none }
    .chip input { position:absolute; opacity:0; pointer-events:none }
    .chip span { border:1px solid #cbd5e1; border-radius:9999px; padding:2px 10px; font-size:12px; color:#334155; background:#fff }
    .chip input:checked + span { background:#4f46e5; border-color:#4f46e5; color:#fff }
    .chip input:focus-visible + span { outline:2px solid #818cf8; outline-offset:1px }
    .tab-active { border-bottom:2px solid #4f46e5; color:#4338ca; font-weight:600 }
    details > summary { cursor:pointer; list-style:none }
    details > summary::-webkit-details-marker { display:none }
  </style>
</head>
<body class="bg-slate-50 text-slate-800 min-h-screen" data-me="${me.id}" data-role="${esc(me.role)}">
  <header class="bg-gradient-to-r from-indigo-600 to-blue-600 text-white shadow">
    <nav class="max-w-7xl mx-auto px-4 py-3 flex flex-wrap items-center gap-3">
      <a href="/ai" class="font-bold mr-auto"><i class="fas fa-magnifying-glass-chart mr-2"></i>求人横断検索AI <span class="text-xs font-normal opacity-80 ml-1">AI検索（求人DB）</span></a>
      <a href="/manual" class="text-sm bg-white text-indigo-700 hover:bg-indigo-50 font-semibold rounded-full px-4 py-1.5"><i class="fas fa-sliders mr-1"></i>手動検索</a>
      <button id="history-button" class="text-sm bg-white/20 hover:bg-white/30 rounded-full px-4 py-1.5"><i class="fas fa-clock-rotate-left mr-1"></i>検索履歴</button>
      <a href="/legacy" class="text-xs opacity-80 hover:opacity-100 underline">旧AI検索</a>
    </nav>
  </header>

  <main class="max-w-7xl mx-auto px-4 py-5 grid grid-cols-1 lg:grid-cols-[380px_1fr] gap-5">
    <!-- 左: 求職者と条件 -->
    <section id="condition-panel" class="space-y-4">
      <section id="candidate-section" class="bg-white rounded-xl shadow-sm border p-4">
        <div class="flex items-center justify-between mb-2">
          <h2 class="font-bold text-sm"><i class="fas fa-user-tie mr-1 text-indigo-600"></i>求職者</h2>
          <div class="flex gap-2">
            <button id="pick-candidate-button" class="text-xs border rounded px-2 py-1 hover:bg-slate-50">呼び出す</button>
            <button id="new-candidate-button" class="text-xs bg-indigo-600 text-white rounded px-2 py-1 hover:bg-indigo-700">新規登録</button>
          </div>
        </div>
        <div id="candidate-empty" class="text-xs text-slate-500 leading-relaxed">
          求職者を登録すると、書類・検索結果・紹介済みの求人が保存され、あとで呼び出して再検索できます。<br>登録せずに検索することもできます（結果は履歴にだけ残ります）。
        </div>
        <div id="candidate-card" class="hidden">
          <div class="flex items-start justify-between gap-2">
            <div>
              <p class="text-lg font-bold leading-tight"><span id="candidate-name"></span> <span id="candidate-no" class="text-xs font-normal text-slate-500"></span></p>
              <p id="candidate-meta" class="text-[11px] text-slate-500 mt-0.5"></p>
            </div>
            <div class="flex gap-1">
              <button id="edit-candidate-button" class="text-xs border rounded px-2 py-1" title="名前・メモを編集"><i class="fas fa-pen"></i></button>
              <button id="clear-candidate-button" class="text-xs border rounded px-2 py-1" title="選択を外す"><i class="fas fa-xmark"></i></button>
            </div>
          </div>
          <div class="mt-3">
            <div class="flex items-center justify-between">
              <p class="text-xs font-semibold text-slate-600">書類（PDF・複数可）</p>
              <label class="text-xs text-indigo-700 cursor-pointer hover:underline"><i class="fas fa-plus mr-1"></i>追加
                <input id="document-input" type="file" accept="application/pdf" multiple class="hidden">
              </label>
            </div>
            <select id="document-kind" class="mt-1 text-xs border rounded px-1 py-0.5">
              <option value="cv">職務経歴書</option><option value="resume">履歴書</option><option value="other">その他</option>
            </select>
            <ul id="document-list" class="mt-1 space-y-1 text-xs"></ul>
            <p class="text-[11px] text-slate-400 mt-1">氏名・住所・連絡先は伏せてから保存します。PDFそのものは保存しません。</p>
            <button id="profile-button" class="hidden mt-2 text-xs border rounded px-2 py-1 hover:bg-slate-50"><i class="fas fa-id-card mr-1"></i>読み取った経歴を見る</button>
          </div>
          <div class="mt-3">
            <p class="text-xs font-semibold text-slate-600">紹介済み <span id="referral-count" class="text-slate-400 font-normal"></span></p>
            <ul id="referral-list" class="mt-1 space-y-1 text-xs max-h-32 overflow-y-auto"></ul>
            <p class="text-[11px] text-slate-400">紹介済みの求人は、次の検索から自動で除外します。</p>
          </div>
          <div class="mt-3">
            <p class="text-xs font-semibold text-slate-600">この人の検索履歴</p>
            <ul id="candidate-search-list" class="mt-1 space-y-1 text-xs max-h-40 overflow-y-auto"></ul>
          </div>
        </div>
      </section>

      <form id="search-form" class="bg-white rounded-xl shadow-sm border p-4 space-y-4">
        <div class="flex items-center justify-between">
          <h2 class="font-bold text-sm"><i class="fas fa-sliders mr-1 text-indigo-600"></i>検索条件</h2>
          <button type="button" id="reset-button" class="text-xs text-slate-500 hover:text-red-600"><i class="fas fa-rotate-left mr-1"></i>条件をリセット</button>
        </div>
        <label class="block text-sm font-semibold">要望（自由記述）<span class="text-[11px] font-normal text-indigo-600 ml-1">AIが最も重視します</span>
          <textarea name="freeText" rows="4" class="mt-1 w-full border rounded px-2 py-1.5 text-sm font-normal" placeholder="例）法人営業3年。顧客と長く付き合う仕事がしたい。転勤は避けたい。"></textarea>
        </label>
        <label class="block text-sm font-semibold">担当者メモ<span class="text-[11px] font-normal text-slate-500 ml-1">面談で聞いた補足など</span>
          <textarea name="memo" rows="2" class="mt-1 w-full border rounded px-2 py-1.5 text-sm font-normal" placeholder="例）英語は日常会話レベル。年収より働き方を優先したい。"></textarea>
        </label>
        <label class="block text-sm font-semibold">希望職種（参考）
          <input name="desiredJobs" class="mt-1 w-full border rounded px-2 py-1.5 text-sm font-normal" placeholder="例）カスタマーサクセス、営業企画">
          <span class="text-[11px] font-normal text-slate-500">AIが参考にします（これで絞り込みはしません。思いつかない職種も提案します）</span>
        </label>

        <div class="grid grid-cols-3 gap-2">
          <label class="text-xs font-semibold">希望年収（下限）<div class="flex items-center gap-1 mt-1"><input name="salaryMin" type="number" min="0" class="w-full border rounded px-2 py-1 text-sm" placeholder="400"><span class="text-[11px]">万</span></div></label>
          <label class="text-xs font-semibold">年齢<div class="flex items-center gap-1 mt-1"><input name="age" type="number" min="15" max="80" class="w-full border rounded px-2 py-1 text-sm" placeholder="30"><span class="text-[11px]">歳</span></div></label>
          <label class="text-xs font-semibold">提案件数<input name="topN" type="number" min="1" max="100" value="20" class="mt-1 w-full border rounded px-2 py-1 text-sm"></label>
          <label class="text-xs font-semibold">性別<select name="gender" class="mt-1 w-full border rounded px-1 py-1 text-sm"><option value="">指定なし</option><option>男性</option><option>女性</option></select></label>
          <label class="text-xs font-semibold col-span-2">最終学歴<select name="education" class="mt-1 w-full border rounded px-1 py-1 text-sm"><option value="">指定なし</option><option>中卒</option><option>高卒</option><option>専門卒</option><option>短大卒</option><option>高専卒</option><option>大卒</option><option>大学院卒</option></select></label>
        </div>

        <fieldset>
          <legend class="text-xs font-semibold mb-1">勤務地 <span class="font-normal text-slate-400">未選択＝全国</span></legend>
          <div id="pref-chips" class="flex flex-wrap gap-1 max-h-28 overflow-y-auto border rounded p-2">${chips('locations', PREFS.map((p) => [p, p]))}</div>
          <label class="text-[11px] text-slate-500 flex items-center gap-1 mt-1"><input type="checkbox" name="includeNationwide" checked> 「全国」「勤務地不問」の求人も含める</label>
        </fieldset>
        <fieldset>
          <legend class="text-xs font-semibold mb-1">働き方 <span class="font-normal text-slate-400">選んだものをすべて満たす求人だけ</span></legend>
          <div class="flex flex-wrap gap-1">${chips('features', FEATURES)}</div>
        </fieldset>
        <fieldset>
          <legend class="text-xs font-semibold mb-1">雇用形態 <span class="font-normal text-slate-400">複数可・未選択＝すべて</span></legend>
          <div class="flex flex-wrap gap-1">${chips('employment', EMPLOYMENT.map((e) => [e, e]))}</div>
        </fieldset>
        <fieldset>
          <legend class="text-xs font-semibold mb-1">媒体 <span class="font-normal text-slate-400">未選択＝すべて</span></legend>
          <div class="flex flex-wrap gap-1">${chips('sources', SOURCES)}</div>
        </fieldset>
        <div id="job-keys-box" class="hidden text-xs bg-amber-50 border border-amber-200 rounded p-2">
          <i class="fas fa-list-check mr-1 text-amber-600"></i>手動検索で選んだ <b id="job-keys-count"></b> 件の求人だけをAIで審査します。
          <button type="button" id="clear-job-keys" class="ml-1 underline">解除</button>
        </div>

        <details class="text-xs">
          <summary class="text-slate-600 font-semibold"><i class="fas fa-gear mr-1"></i>詳細設定</summary>
          <div class="mt-2 grid grid-cols-2 gap-2">
            <label>探す範囲<select name="depth" class="mt-1 w-full border rounded px-1 py-1"><option value="standard">標準（関連の強い2,000件を審査）</option><option value="deep">徹底（8,000件・時間と費用がかかる）</option></select></label>
            <label>費用モード<select name="costMode" class="mt-1 w-full border rounded px-1 py-1"><option value="">標準（約70〜80円）</option><option value="economy">節約</option><option value="quality">精度優先（約150円〜）</option></select></label>
            <label class="col-span-2 flex items-center gap-1"><input type="checkbox" name="useDocuments" checked> 登録した書類（経歴）を使う</label>
          </div>
        </details>

        <button id="run-button" type="submit" class="w-full bg-indigo-600 hover:bg-indigo-700 disabled:bg-slate-300 text-white font-semibold rounded-lg py-2.5"><i class="fas fa-wand-magic-sparkles mr-1"></i>AIで検索する</button>
        <p class="text-[11px] text-slate-400 text-center">1回あたり数分・約70〜80円（標準）。複数の担当者が同時に検索できます（同時に実行できる数を超えたときだけ順番待ち）。</p>
      </form>
    </section>

    <!-- 右: 進捗と結果 -->
    <section id="result-panel" class="space-y-4 min-w-0">
      <section id="progress-section" class="hidden bg-white rounded-xl shadow-sm border p-4">
        <div class="flex items-center justify-between gap-2">
          <h2 class="font-bold text-sm"><i id="progress-icon" class="fas fa-spinner fa-spin mr-1 text-indigo-600"></i><span id="progress-title">AIが検索しています</span></h2>
          <button id="cancel-button" class="text-xs border border-red-200 text-red-600 rounded px-2 py-1 hover:bg-red-50">中止する</button>
        </div>
        <p id="progress-message" class="text-sm mt-2"></p>
        <div class="mt-2 h-1.5 bg-slate-100 rounded overflow-hidden"><div id="progress-bar" class="h-full bg-indigo-500 transition-all" style="width:5%"></div></div>
        <details id="progress-details" class="mt-2" open><summary class="text-[11px] text-slate-500 cursor-pointer">経過（詳細）</summary><ol id="progress-log" class="mt-1 text-[11px] leading-relaxed font-mono text-slate-600 bg-slate-50 rounded p-2 space-y-0.5 max-h-72 overflow-y-auto whitespace-pre-wrap break-all"></ol></details>
      </section>

      <section id="plan-section" class="hidden bg-indigo-50/60 border border-indigo-100 rounded-xl p-4">
        <h2 class="font-bold text-sm mb-1"><i class="fas fa-lightbulb mr-1 text-amber-500"></i>AIの解釈と探し方</h2>
        <p id="plan-understanding" class="text-sm"></p>
        <ul id="plan-angles" class="mt-2 space-y-1 text-xs"></ul>
      </section>

      <section id="results-section" class="bg-white rounded-xl shadow-sm border p-4">
        <div class="flex flex-wrap items-center justify-between gap-2 border-b pb-2">
          <div class="flex gap-4 text-sm">
            <button class="result-tab tab-active pb-1" data-tab="recommended">提案 <span id="recommended-count">0</span></button>
            <button class="result-tab pb-1 text-slate-500" data-tab="reference">参考（要件不足） <span id="reference-count">0</span></button>
          </div>
          <p id="result-summary" class="text-[11px] text-slate-500"></p>
        </div>
        <div id="result-list" class="mt-3 space-y-3">
          <p class="text-sm text-slate-400">左で条件を入力して「AIで検索する」を押してください。</p>
        </div>
      </section>
    </section>
  </main>

  <!-- 求職者の呼び出し -->
  <dialog id="candidate-dialog" class="rounded-xl shadow-xl p-0 w-full max-w-2xl backdrop:bg-black/40">
    <div class="p-4 border-b flex items-center gap-2">
      <h2 class="font-bold mr-auto">求職者を呼び出す</h2>
      <label class="text-xs flex items-center gap-1"><input id="mine-only" type="checkbox"> 自分の担当だけ</label>
      <button class="dialog-close text-slate-400 hover:text-slate-700"><i class="fas fa-xmark"></i></button>
    </div>
    <div class="p-4">
      <input id="candidate-search-input" class="w-full border rounded px-3 py-2 text-sm" placeholder="名前・ふりがな・No.で検索">
      <ul id="candidate-results" class="mt-3 divide-y max-h-[60vh] overflow-y-auto"></ul>
    </div>
  </dialog>

  <!-- 求職者の登録・編集 -->
  <dialog id="candidate-edit-dialog" class="rounded-xl shadow-xl p-0 w-full max-w-md backdrop:bg-black/40">
    <form id="candidate-edit-form" class="p-5 space-y-3">
      <h2 id="candidate-edit-title" class="font-bold">求職者を登録</h2>
      <label class="block text-sm">名前<input name="name" required maxlength="60" class="mt-1 w-full border rounded px-3 py-2" placeholder="例: 山田 太郎"></label>
      <label class="block text-sm">ふりがな（任意）<input name="name_kana" maxlength="60" class="mt-1 w-full border rounded px-3 py-2"></label>
      <p class="text-[11px] text-slate-500">番号（No.）は自動で付きます。同姓同名でも番号で区別できます。名前はAIには送りません（書類からも伏せます）。</p>
      <p id="candidate-edit-error" class="hidden text-sm text-red-600"></p>
      <div class="flex justify-between items-center pt-1">
        <div class="flex gap-2">
          <button type="button" id="archive-candidate-button" class="hidden text-xs text-slate-500 underline">アーカイブ（一覧から外す）</button>
          <button type="button" id="delete-candidate-button" class="hidden text-xs text-red-600 underline">完全に削除</button>
        </div>
        <div class="flex gap-2">
          <button type="button" class="dialog-close text-sm border rounded px-3 py-1.5">キャンセル</button>
          <button type="submit" class="text-sm bg-indigo-600 text-white rounded px-3 py-1.5">保存</button>
        </div>
      </div>
    </form>
  </dialog>

  <!-- 経歴の表示 -->
  <dialog id="profile-dialog" class="rounded-xl shadow-xl p-0 w-full max-w-2xl backdrop:bg-black/40">
    <div class="p-4 border-b flex items-center"><h2 class="font-bold mr-auto">書類から読み取った経歴（AIが使う情報）</h2><button class="dialog-close text-slate-400"><i class="fas fa-xmark"></i></button></div>
    <pre id="profile-text" class="p-4 text-xs whitespace-pre-wrap max-h-[70vh] overflow-y-auto"></pre>
  </dialog>

  <!-- 検索履歴（全体） -->
  <dialog id="history-dialog" class="rounded-xl shadow-xl p-0 w-full max-w-3xl backdrop:bg-black/40">
    <div class="p-4 border-b flex items-center gap-2">
      <h2 class="font-bold mr-auto">AI検索の履歴</h2>
      <label class="text-xs flex items-center gap-1"><input id="history-mine" type="checkbox"> 自分の検索だけ</label>
      <button class="dialog-close text-slate-400"><i class="fas fa-xmark"></i></button>
    </div>
    <ul id="history-list" class="p-4 divide-y max-h-[70vh] overflow-y-auto"></ul>
  </dialog>

  <script src="/static/ai.js"></script>
</body>
</html>`
}
