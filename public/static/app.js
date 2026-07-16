// フロントエンド ロジック

const PREFS = ['北海道','青森県','岩手県','宮城県','秋田県','山形県','福島県','茨城県','栃木県','群馬県','埼玉県','千葉県','東京都','神奈川県','新潟県','富山県','石川県','福井県','山梨県','長野県','岐阜県','静岡県','愛知県','三重県','滋賀県','京都府','大阪府','兵庫県','奈良県','和歌山県','鳥取県','島根県','岡山県','広島県','山口県','徳島県','香川県','愛媛県','高知県','福岡県','佐賀県','長崎県','熊本県','大分県','宮崎県','鹿児島県','沖縄県','海外'];
const EMPLOYMENT = ['正社員','契約社員','業務委託','アルバイト','その他'];
const JOB_CATS = ['ITエンジニア・PM','経営・管理・人事','金融専門職','事務','建設・不動産専門職','営業・コールセンター・カスタマーサポート','軽作業・運送','技能工・警備・清掃','クリエイティブ・Web制作','コンサルタント・士業','化学・素材','販売・サービス','マーケティング・企画・広報','メディカル専門職','公務員・公共職員・農林水産','機械・電気・電子・半導体','食品・化粧品・日用品'];
const HOLIDAYS = ['土日祝休み','土日休み','週休2日(土日以外)','シフト制','その他'];
const SOURCES = [
  { id: 'kintone', label: '自社DB (kintone)', connected: true },
  { id: 'circus', label: 'circusAGENT', connected: true },
  { id: 'hitolink', label: 'ヒトリンク', connected: false },
  { id: 'jobins', label: 'ジョビンズ', connected: false },
];

// DB担当ごとのミニキャラクター絵文字（AIスタッフの見た目）
const STAFF_AVATAR = {
  kintone: '🧑‍💼',
  circus: '🕵️',
  hitolink: '🧑‍💻',
  jobins: '👩‍💼',
};

const PHASE_INFO = {
  idle:      { icon: 'fa-hourglass-start', color: 'text-slate-400', bg: 'bg-slate-50',   label: '待機中' },
  fetching:  { icon: 'fa-cloud-arrow-down', color: 'text-blue-500', bg: 'bg-blue-50',    label: '取得中' },
  filtering: { icon: 'fa-filter',           color: 'text-amber-500', bg: 'bg-amber-50',  label: '絞込中' },
  scoring:   { icon: 'fa-brain',            color: 'text-purple-500', bg: 'bg-purple-50', label: 'AI採点中' },
  done:      { icon: 'fa-circle-check',     color: 'text-green-600', bg: 'bg-green-50',  label: '完了' },
  error:     { icon: 'fa-triangle-exclamation', color: 'text-red-500', bg: 'bg-red-50', label: 'エラー' },
  skipped:   { icon: 'fa-plug-circle-xmark', color: 'text-slate-400', bg: 'bg-slate-50', label: '未接続' },
};

// チップUI生成
function makeChips(container, items, name) {
  container.innerHTML = '';
  items.forEach(v => {
    const id = name + '_' + v;
    const label = document.createElement('label');
    label.className = 'cursor-pointer';
    label.innerHTML = `<input type="checkbox" value="${v}" class="peer hidden" data-group="${name}">
      <span class="inline-block text-xs px-2 py-1 rounded-full border border-slate-300 text-slate-600 peer-checked:bg-indigo-600 peer-checked:text-white peer-checked:border-indigo-600">${v}</span>`;
    container.appendChild(label);
  });
}

function getChecked(name) {
  return Array.from(document.querySelectorAll(`input[data-group="${name}"]:checked`)).map(e => e.value);
}

// 初期化
function initForm() {
  makeChips(document.getElementById('locations'), PREFS, 'loc');
  makeChips(document.getElementById('employment'), EMPLOYMENT, 'emp');
  makeChips(document.getElementById('holiday'), HOLIDAYS, 'hol');

  const jobSel = document.getElementById('jobCategories');
  JOB_CATS.forEach(v => {
    const o = document.createElement('option'); o.value = v; o.textContent = v; jobSel.appendChild(o);
  });

  const srcBox = document.getElementById('sources');
  SOURCES.forEach(s => {
    const label = document.createElement('label');
    label.className = 'cursor-pointer';
    const badge = s.connected ? '' : '<span class="text-[10px] text-amber-600">(準備中)</span>';
    label.innerHTML = `<input type="checkbox" value="${s.id}" class="peer hidden" data-group="src" ${s.connected ? 'checked' : ''}>
      <span class="inline-flex items-center gap-1 text-xs px-3 py-1.5 rounded-lg border border-slate-300 text-slate-600 peer-checked:bg-indigo-600 peer-checked:text-white peer-checked:border-indigo-600">${s.label}${badge}</span>`;
    srcBox.appendChild(label);
  });
}

// 総求人数の取得
async function loadStats() {
  try {
    const res = await fetch('/api/stats');
    const data = await res.json();
    document.getElementById('grand-total-num').textContent = data.grandTotal.toLocaleString();
  } catch (e) {
    document.getElementById('grand-total-num').textContent = '取得失敗';
  }
}

// HTMLエスケープ（エラー全文などをそのまま埋め込む用）
function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// クリップボードにコピー
function copyText(text, btn) {
  const done = () => {
    if (!btn) return;
    const orig = btn.innerHTML;
    btn.innerHTML = '<i class="fas fa-check mr-1"></i>コピーしました';
    setTimeout(() => { btn.innerHTML = orig; }, 1800);
  };
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(text).then(done).catch(() => fallbackCopy(text, done));
  } else {
    fallbackCopy(text, done);
  }
}
function fallbackCopy(text, cb) {
  const ta = document.createElement('textarea');
  ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
  document.body.appendChild(ta); ta.select();
  try { document.execCommand('copy'); } catch (e) {}
  document.body.removeChild(ta); if (cb) cb();
}

// worker状態のレンダリング
function renderWorkers(workers) {
  const box = document.getElementById('workers');
  if (!workers || workers.length === 0) return;
  box.innerHTML = '';
  workers.forEach(w => {
    const info = PHASE_INFO[w.phase] || PHASE_INFO.idle;
    const active = ['fetching','filtering','scoring'].includes(w.phase);
    const dot = active ? '<span class="pulse-dot inline-block w-2 h-2 rounded-full bg-green-500 mr-1"></span>' : '';

    // ミニキャラクターの状態クラス
    let stateClass = '';
    if (active) stateClass = 'staff-working';
    else if (w.phase === 'done') stateClass = 'staff-done';
    else if (w.phase === 'error') stateClass = 'staff-error';
    const avatar = STAFF_AVATAR[w.source] || '🧑‍💼';
    // 作業中の頭上エフェクト（採点中は電球、取得/絞込は汗）
    const fx = w.phase === 'scoring' ? '💡' : (active ? '💦' : (w.phase === 'done' ? '✅' : (w.phase === 'error' ? '❗' : '')));

    // エラー全文（あればコピー可能ブロックを表示）
    const errText = w.phase === 'error' ? (w.error || w.message || 'エラーが発生しました') : '';
    // 通常メッセージ欄：エラー時は簡潔に（全文は下のコピーボックスに表示）
    const shortMsg = w.phase === 'error' ? 'エラーが発生しました（下記の内容をご確認ください）' : (w.message || '');
    const errBlock = errText ? `
      <div class="mt-2 bg-red-50 border border-red-200 rounded-lg p-2">
        <div class="flex items-center justify-between mb-1">
          <span class="text-[11px] font-semibold text-red-600"><i class="fas fa-triangle-exclamation mr-1"></i>エラー内容（全文）</span>
          <button class="copy-err-btn text-[11px] bg-red-100 hover:bg-red-200 text-red-700 px-2 py-0.5 rounded" data-err="${escapeHtml(errText)}">
            <i class="fas fa-copy mr-1"></i>全文コピー
          </button>
        </div>
        <pre class="err-box text-[11px] text-red-700 max-h-40 overflow-auto bg-white/60 rounded p-2 border border-red-100">${escapeHtml(errText)}</pre>
      </div>` : '';

    const card = document.createElement('div');
    card.className = `worker-card ${info.bg} rounded-xl p-4 border border-slate-200 shadow-sm`;
    card.innerHTML = `
      <div class="flex items-start gap-3">
        <div class="staff-avatar ${stateClass}">
          <span class="staff-body">${avatar}</span>
          <span class="staff-laptop">💻</span>
          <span class="staff-fx">${fx}</span>
        </div>
        <div class="flex-1 min-w-0">
          <div class="flex items-center justify-between mb-1">
            <span class="font-semibold text-sm text-slate-700">${w.label}</span>
            <span class="text-xs ${info.color} font-semibold">${dot}<i class="fas ${info.icon} mr-1"></i>${info.label}</span>
          </div>
          <p class="text-xs ${w.phase === 'error' ? 'text-red-600 font-semibold' : 'text-slate-500'} mb-2 min-h-[2rem]">${escapeHtml(shortMsg)}</p>
          <div class="flex flex-wrap gap-x-3 gap-y-0.5 text-[11px] text-slate-500">
            ${w.totalInDb ? `<span>総<b>${w.totalInDb}</b></span>` : ''}
            ${w.candidates ? `<span>候補<b>${w.candidates}</b></span>` : ''}
            <span>マッチ<b class="text-indigo-600">${w.matched}</b></span>
            ${w.fromMemory ? `<span title="記憶から即提案"><i class="fas fa-lightbulb text-amber-400"></i>記憶${w.fromMemory}</span>` : ''}
            ${w.tokensUsed ? `<span title="消費トークン"><i class="fas fa-coins text-yellow-500"></i>${w.tokensUsed}</span>` : ''}
          </div>
          ${errBlock}
        </div>
      </div>`;
    box.appendChild(card);
  });

  // エラー全文コピーボタンのハンドラ
  box.querySelectorAll('.copy-err-btn').forEach(btn => {
    btn.addEventListener('click', () => copyText(btn.getAttribute('data-err') || '', btn));
  });
}

// 結果カードのレンダリング（追記型）
const shownResults = new Set();
function renderResults(items) {
  const box = document.getElementById('results');
  if (shownResults.size === 0 && items.length > 0) box.innerHTML = '';
  // スコア順に整列して全再描画（新着含む）
  items.forEach(it => {
    if (shownResults.has(it.resultId)) return;
    shownResults.add(it.resultId);
  });
  // 全件をスコア順で並べ替えて描画
  window._allResults = window._allResults || [];
  items.forEach(it => {
    if (!window._allResults.find(x => x.resultId === it.resultId)) window._allResults.push(it);
  });
  window._allResults.sort((a,b) => b.score - a.score);

  box.innerHTML = '';
  window._allResults.forEach(it => {
    const j = it.job || {};
    const color = it.score >= 80 ? '#16a34a' : it.score >= 65 ? '#ca8a04' : '#64748b';
    const salary = (j.salaryMin || j.salaryMax) ? `${j.salaryMin||'?'}〜${j.salaryMax||'?'}万円` : '年収非公開';
    const memBadge = it.fromMemory ? '<span class="text-[10px] bg-amber-100 text-amber-700 px-1.5 py-0.5 rounded"><i class="fas fa-lightbulb"></i>記憶</span>' : '';
    const card = document.createElement('div');
    card.className = 'result-in border border-slate-200 rounded-lg p-4 hover:shadow-md transition';
    card.innerHTML = `
      <div class="flex items-start gap-3">
        <div class="score-ring flex-shrink-0 w-14 h-14 rounded-full flex items-center justify-center" style="--c:${color};--p:${it.score}">
          <div class="w-11 h-11 bg-white rounded-full flex items-center justify-center">
            <span class="font-bold text-sm" style="color:${color}">${it.score}</span>
          </div>
        </div>
        <div class="flex-1 min-w-0">
          <div class="flex items-center gap-2 flex-wrap">
            <span class="text-[10px] bg-indigo-100 text-indigo-700 px-1.5 py-0.5 rounded">${it.sourceLabel}</span>
            ${memBadge}
            <span class="text-xs text-slate-400">${j.company||''}</span>
          </div>
          <h3 class="font-bold text-slate-800 mt-1 leading-snug">${j.title||'(無題)'}</h3>
          <div class="flex flex-wrap gap-x-3 gap-y-0.5 text-xs text-slate-500 mt-1">
            <span><i class="fas fa-briefcase mr-1"></i>${j.jobCategory||'-'}</span>
            <span><i class="fas fa-location-dot mr-1"></i>${(j.locations||[]).join('/')||'-'}</span>
            <span><i class="fas fa-yen-sign mr-1"></i>${salary}</span>
            <span><i class="fas fa-file-signature mr-1"></i>${j.employment||'-'}</span>
          </div>
          ${it.reason ? `<p class="text-xs text-indigo-600 mt-2 bg-indigo-50 rounded px-2 py-1"><i class="fas fa-quote-left mr-1 opacity-50"></i>${it.reason}</p>` : ''}
          ${j.url ? `<a href="${j.url}" target="_blank" class="text-xs text-blue-500 hover:underline mt-1 inline-block"><i class="fas fa-external-link mr-1"></i>詳細を見る</a>` : ''}
        </div>
      </div>`;
    box.appendChild(card);
  });
  document.getElementById('result-count').textContent = `(${window._allResults.length})`;
}

// 検索実行
let pollTimer = null;
async function startSearch() {
  const btn = document.getElementById('searchBtn');
  btn.disabled = true;
  btn.innerHTML = '<i class="fas fa-spinner fa-spin mr-2"></i>AIスタッフが探しています…';

  // リセット
  shownResults.clear();
  window._allResults = [];
  document.getElementById('results').innerHTML = '<p class="text-sm text-slate-400">AIスタッフが求人を探しています…見つかり次第ここに表示されます。</p>';
  document.getElementById('result-count').textContent = '(0)';

  const criteria = {
    freeText: document.getElementById('freeText').value.trim(),
    locations: getChecked('loc'),
    salaryMin: parseInt(document.getElementById('salaryMin').value) || null,
    salaryMax: null,
    employment: getChecked('emp'),
    jobCategories: Array.from(document.getElementById('jobCategories').selectedOptions).map(o => o.value),
    industries: [],
    overtimeMax: document.getElementById('overtimeMax').value,
    holiday: getChecked('hol'),
    benefits: [],
    requirements: '',
    // 応募条件（HIGH優先の確定データ）
    age: parseInt(document.getElementById('age').value) || null,
    gender: document.getElementById('gender').value,
    education: document.getElementById('education').value,
    topN: parseInt(document.getElementById('topN').value) || 10,
    sources: getChecked('src'),
  };

  try {
    const res = await fetch('/api/search', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(criteria),
    });
    const data = await res.json();
    const jobId = data.searchJobId;
    pollStatus(jobId);
  } catch (e) {
    document.getElementById('search-status').textContent = '検索開始に失敗しました';
    // 検索開始自体の失敗も、AIスタッフ欄にエラー全文＋コピーボタンで表示する
    renderWorkers([{
      source: 'circus', label: '検索リクエスト',
      phase: 'error', matched: 0,
      message: `検索開始に失敗しました: ${String(e && e.stack ? e.stack : (e && e.message ? e.message : e))}`,
    }]);
    resetBtn();
  }
}

function resetBtn() {
  const btn = document.getElementById('searchBtn');
  btn.disabled = false;
  btn.innerHTML = '<i class="fas fa-robot mr-2"></i>AIスタッフに探してもらう';
}

// 進捗＋結果ポーリング
function pollStatus(jobId) {
  let lastResultId = 0;
  const poll = async () => {
    try {
      const [statusRes, resultsRes] = await Promise.all([
        fetch(`/api/search/${jobId}/status`),
        fetch(`/api/search/${jobId}/results?since=${lastResultId}`),
      ]);
      const status = await statusRes.json();
      const results = await resultsRes.json();

      renderWorkers(status.workers);
      if (results.items && results.items.length > 0) {
        renderResults(results.items);
        lastResultId = Math.max(lastResultId, results.maxId);
      }

      const statusEl = document.getElementById('search-status');
      if (status.status === 'done') {
        statusEl.textContent = `完了 (スキャン${status.totalScanned}件)`;
        clearInterval(pollTimer);
        resetBtn();
      } else {
        statusEl.textContent = '検索中…';
      }
    } catch (e) {
      console.error(e);
    }
  };
  poll();
  pollTimer = setInterval(poll, 1500);
}

// 起動
initForm();
loadStats();
document.getElementById('searchBtn').addEventListener('click', startSearch);
