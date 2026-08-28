// 手動検索モード フロントJS
// 自社DB(jobs)を /api/manual/jobs で検索し、/api/trace/* で同期を制御する。
(function () {
  'use strict';

  var state = { page: 1, pageSize: 20, totalPages: 1, lastJobs: [] };
  var syncTimer = null;
  var SRC_LABELS = { circus: 'circus', hitolink: 'ヒトリンク', jobins: 'JOBINS', kintone: 'kintone' };

  function $(id) { return document.getElementById(id); }
  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }
  function srcClass(s) {
    return ({ circus: 'src-circus', hitolink: 'src-hitolink', jobins: 'src-jobins', kintone: 'src-kintone' })[s] || 'src-circus';
  }
  // 年収は「万円」で保持。DB値が円(>=10000)なら万円換算、小さければそのまま万円扱い。
  function toManYen(v) {
    if (v == null) return null;
    var n = Number(v);
    if (!isFinite(n)) return null;
    return n >= 10000 ? Math.round(n / 10000) : Math.round(n);
  }
  function salaryText(lo, hi) {
    lo = toManYen(lo); hi = toManYen(hi);
    if (lo == null && hi == null) return '応相談';
    if (lo != null && hi != null) return lo + '〜' + hi + '万円';
    if (lo != null) return lo + '万円〜';
    return '〜' + hi + '万円';
  }
  function rewardText(reward) {
    if (!reward) return '';
    if (reward.text) return reward.text;
    if (reward.rate != null) return '理論年収の' + reward.rate + '%';
    if (reward.amount != null) return toManYen(reward.amount) + '万円';
    return '';
  }
  function ageText(min, max) {
    if (min == null && max == null) return '不問';
    if (min != null && max != null) return min + '〜' + max + '歳';
    if (min != null) return min + '歳〜';
    return '〜' + max + '歳';
  }
  function fmtDate(s) {
    if (!s) return '';
    var d = new Date(s);
    if (isNaN(d.getTime())) return String(s).slice(0, 10);
    return d.getFullYear() + '/' + ('0' + (d.getMonth() + 1)).slice(-2) + '/' + ('0' + d.getDate()).slice(-2);
  }

  // ---- ファセット(選択肢)読み込み ----
  function loadFacets() {
    fetch('/api/manual/facets').then(function (r) { return r.json(); }).then(function (d) {
      // 媒体プルダウン
      var sel = $('f-source');
      if (sel && d.sources) {
        sel.innerHTML = '<option value="">すべての媒体</option>';
        Object.keys(d.sources).forEach(function (s) {
          var info = d.sources[s];
          var opt = document.createElement('option');
          opt.value = s;
          opt.textContent = info.label + '（掲載中 ' + (info.open || 0).toLocaleString() + '件）';
          sel.appendChild(opt);
        });
      }
      // 職種/業種は配列展開版(Flat)を優先し、無ければ従来版
      fillDatalist('dl-category', (d.categoriesFlat && d.categoriesFlat.length) ? d.categoriesFlat : d.categories);
      fillDatalist('dl-industry', (d.industriesFlat && d.industriesFlat.length) ? d.industriesFlat : d.industries);
      fillDatalist('dl-employment', d.employments);
      fillDatalist('dl-location', d.locations);
      fillDatalist('dl-position', d.positions);
      fillDatalist('dl-education', d.educations);
      // 性別セレクト
      fillSelect('f-gender', d.genders, '指定なし');
      // 成果報酬タイプ
      var rewardMap = { rate: '料率型（年収×%）', fixed: '固定額型', unknown: 'その他' };
      var rt = $('f-rewardType');
      if (rt && d.rewardTypes) {
        rt.innerHTML = '<option value="">指定なし</option>';
        d.rewardTypes.forEach(function (v) {
          var o = document.createElement('option'); o.value = v;
          o.textContent = rewardMap[v] || v; rt.appendChild(o);
        });
      }
    }).catch(function () {});
  }
  function fillDatalist(id, arr) {
    var dl = $(id); if (!dl || !arr) return;
    dl.innerHTML = '';
    arr.slice(0, 300).forEach(function (v) {
      var o = document.createElement('option'); o.value = v; dl.appendChild(o);
    });
  }
  function fillSelect(id, arr, blank) {
    var sel = $(id); if (!sel || !arr) return;
    sel.innerHTML = '<option value="">' + (blank || '指定なし') + '</option>';
    arr.forEach(function (v) {
      if (!v) return;
      var o = document.createElement('option'); o.value = v; o.textContent = v; sel.appendChild(o);
    });
  }

  // ---- 検索実行 ----
  function search(page) {
    state.page = page || 1;
    var params = new URLSearchParams();
    var kw = $('f-keyword').value.trim(); if (kw) params.set('keyword', kw);
    var src = $('f-source').value; if (src) params.set('source', src);
    var cat = $('f-category').value.trim(); if (cat) params.set('category', cat);
    var ind = $('f-industry').value.trim(); if (ind) params.set('industry', ind);
    var emp = $('f-employment').value.trim(); if (emp) params.set('employment', emp);
    var loc = $('f-location').value.trim(); if (loc) params.set('location', loc);
    var pos = $('f-position').value.trim(); if (pos) params.set('position', pos);
    var smin = $('f-salaryMin').value; if (smin) params.set('salaryMin', smin);
    var smax = $('f-salaryMax').value; if (smax) params.set('salaryMax', smax);
    var age = $('f-age').value; if (age) params.set('age', age);
    var gen = $('f-gender').value; if (gen) params.set('gender', gen);
    var edu = $('f-education').value.trim(); if (edu) params.set('education', edu);
    var rwt = $('f-rewardType').value; if (rwt) params.set('rewardType', rwt);
    params.set('openState', $('f-openState').value);
    params.set('sort', $('f-sort').value);
    params.set('page', state.page);
    params.set('pageSize', state.pageSize);

    $('results').innerHTML = '<div class="text-center text-gray-400 py-16"><i class="fas fa-circle-notch spin text-3xl"></i></div>';
    $('emptyState').classList.add('hidden');

    fetch('/api/manual/jobs?' + params.toString()).then(function (r) { return r.json(); }).then(function (d) {
      state.totalPages = d.totalPages || 1;
      state.lastJobs = d.jobs || [];
      $('resultCount').textContent = (d.total || 0).toLocaleString();
      renderResults(d.jobs || []);
      renderPager();
    }).catch(function () {
      $('results').innerHTML = '<div class="text-center text-red-400 py-16">読み込みに失敗しました</div>';
    });
  }

  // 小さなタグ（チップ）
  function chip(icon, text, cls) {
    if (!text) return '';
    return '<span class="inline-flex items-center gap-1 text-xs ' + (cls || 'bg-gray-100 text-gray-600') +
      ' rounded-full px-2 py-0.5"><i class="fas ' + icon + '"></i>' + esc(text) + '</span>';
  }

  function renderResults(jobs) {
    var box = $('results');
    if (!jobs.length) {
      box.innerHTML = '';
      $('emptyState').classList.remove('hidden');
      return;
    }
    $('emptyState').classList.add('hidden');
    box.innerHTML = jobs.map(function (j, idx) {
      var locs = (j.locations || []).slice(0, 4).join('・');
      var closed = j.isOpen ? '' : '<span class="src-badge bg-gray-200 text-gray-500 ml-1">掲載終了</span>';
      var rw = rewardText(j.reward);
      // メタチップ（勤務地・雇用形態・報酬・学歴・年齢）
      var chips = [
        locs ? chip('fa-location-dot', locs, 'bg-sky-50 text-sky-700') : '',
        j.employment ? chip('fa-briefcase', j.employment, 'bg-violet-50 text-violet-700') : '',
        rw ? chip('fa-yen-sign', rw, 'bg-amber-50 text-amber-700') : '',
        j.requiredEducation ? chip('fa-graduation-cap', j.requiredEducation, 'bg-gray-100 text-gray-600') : '',
        (j.requiredAgeMin != null || j.requiredAgeMax != null) ? chip('fa-user', ageText(j.requiredAgeMin, j.requiredAgeMax), 'bg-gray-100 text-gray-600') : '',
        (j.positions && j.positions.length) ? chip('fa-user-tie', j.positions.slice(0, 2).join('・'), 'bg-gray-100 text-gray-600') : ''
      ].join('');
      return '' +
        '<article class="job-card bg-white rounded-xl shadow-sm border border-gray-100 p-4">' +
          '<div class="flex items-start justify-between gap-3">' +
            '<div class="min-w-0">' +
              '<div class="flex items-center gap-2 mb-1 flex-wrap">' +
                '<span class="src-badge ' + srcClass(j.source) + '">' + esc(j.sourceLabel) + '</span>' +
                closed +
                (j.jobCategory ? '<span class="text-xs text-gray-500">' + esc(j.jobCategory) + '</span>' : '') +
                (j.industry ? '<span class="text-xs text-gray-400">/ ' + esc(j.industry) + '</span>' : '') +
              '</div>' +
              '<h3 class="font-bold text-gray-800">' + esc(j.title || '(無題)') + '</h3>' +
              '<p class="text-sm text-gray-500">' + esc(j.company || '') +
                (j.companyWebsite ? ' <a href="' + esc(j.companyWebsite) + '" target="_blank" rel="noopener" class="text-emerald-600 hover:underline">サイト</a>' : '') +
              '</p>' +
            '</div>' +
            '<div class="text-right shrink-0">' +
              '<div class="text-emerald-700 font-bold">' + salaryText(j.salaryMin, j.salaryMax) + '</div>' +
              (j.sourceJobId ? '<div class="text-[10px] text-gray-300 mt-1">ID: ' + esc(j.sourceJobId) + '</div>' : '') +
            '</div>' +
          '</div>' +
          (chips ? '<div class="mt-2 flex flex-wrap gap-1.5">' + chips + '</div>' : '') +
          '<div class="mt-2 text-sm text-gray-600" style="display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden">' +
            esc((j.description || '').slice(0, 200)) +
          '</div>' +
          '<div class="mt-3 flex items-center justify-between text-xs text-gray-400">' +
            '<span>' + (j.publishStartedAt ? '掲載: ' + esc(fmtDate(j.publishStartedAt)) : '') + '</span>' +
            '<button data-detail="' + idx + '" class="text-emerald-600 hover:text-emerald-800 font-semibold text-sm"><i class="fas fa-circle-info mr-1"></i>詳細を見る</button>' +
          '</div>' +
        '</article>';
    }).join('');
    // 詳細ボタン
    Array.prototype.forEach.call(box.querySelectorAll('button[data-detail]'), function (b) {
      b.addEventListener('click', function () {
        var i = parseInt(b.getAttribute('data-detail'), 10);
        openDetail(state.lastJobs[i]);
      });
    });
  }

  // ---- 詳細モーダル ----
  function row(label, valueHtml) {
    if (!valueHtml && valueHtml !== 0) return '';
    return '<div class="py-2 border-b border-gray-100 grid grid-cols-3 gap-3">' +
      '<dt class="text-xs font-semibold text-gray-500">' + esc(label) + '</dt>' +
      '<dd class="col-span-2 text-sm text-gray-800 whitespace-pre-wrap break-words">' + valueHtml + '</dd></div>';
  }
  function openDetail(j) {
    if (!j) return;
    var rw = rewardText(j.reward);
    var link = j.url
      ? '<a href="' + esc(j.url) + '" target="_blank" rel="noopener" class="inline-flex items-center gap-1 text-white bg-emerald-600 hover:bg-emerald-700 rounded-lg px-3 py-1.5 text-sm font-semibold"><i class="fas fa-arrow-up-right-from-square"></i>元の求人ページを開く</a>'
      : '<span class="text-gray-400 text-sm">元URLなし</span>';
    var html = '' +
      '<div class="mb-4">' +
        '<div class="flex items-center gap-2 mb-1 flex-wrap">' +
          '<span class="src-badge ' + srcClass(j.source) + '">' + esc(j.sourceLabel) + '</span>' +
          (j.isOpen ? '<span class="src-badge bg-emerald-100 text-emerald-700">掲載中</span>' : '<span class="src-badge bg-gray-200 text-gray-500">掲載終了</span>') +
        '</div>' +
        '<h2 class="text-lg font-bold text-gray-900">' + esc(j.title || '(無題)') + '</h2>' +
        '<p class="text-gray-600">' + esc(j.company || '') + '</p>' +
      '</div>' +
      '<dl>' +
        row('媒体ID', esc(j.sourceJobId)) +
        row('想定年収', salaryText(j.salaryMin, j.salaryMax)) +
        row('職種', esc((j.jobCategories && j.jobCategories.length ? j.jobCategories.join('・') : j.jobCategory))) +
        row('業種', esc((j.industries && j.industries.length ? j.industries.join('・') : j.industry))) +
        row('雇用形態', esc(j.employment)) +
        row('役職・ポジション', esc((j.positions || []).join('・'))) +
        row('キャリア段階', esc(j.careerStage)) +
        row('勤務地', esc((j.locations || []).join('・'))) +
        row('残業', esc(j.overtime)) +
        row('休日', esc(j.holiday)) +
        row('福利厚生', esc(j.benefits)) +
        row('応募可能年齢', ageText(j.requiredAgeMin, j.requiredAgeMax)) +
        row('性別条件', esc(j.requiredGender) || '不問') +
        row('学歴条件', esc(j.requiredEducation) || '不問') +
        row('経験・その他', esc((j.experience || []).join('・'))) +
        row('成果報酬', esc(rw)) +
        row('応募必須条件', esc(j.requirements)) +
        row('仕事内容', esc(j.description)) +
        row('企業サイト', j.companyWebsite ? '<a href="' + esc(j.companyWebsite) + '" target="_blank" rel="noopener" class="text-emerald-600 hover:underline">' + esc(j.companyWebsite) + '</a>' : '') +
        row('媒体掲載日', esc(fmtDate(j.publishStartedAt))) +
        row('媒体更新日', esc(fmtDate(j.sourceUpdatedAt))) +
        row('自社DB登録日', esc(fmtDate(j.firstSeenAt))) +
        row('自社DB最終確認', esc(fmtDate(j.lastSeenAt))) +
      '</dl>' +
      '<div class="mt-5 flex justify-end">' + link + '</div>';
    $('detailBody').innerHTML = html;
    $('detailModal').classList.remove('hidden');
  }
  function closeDetail() { $('detailModal').classList.add('hidden'); }

  function renderPager() {
    var p = $('pager');
    if (state.totalPages <= 1) { p.innerHTML = ''; return; }
    var html = '';
    var cur = state.page;
    function btn(label, page, disabled, active) {
      return '<button data-page="' + page + '" ' + (disabled ? 'disabled' : '') +
        ' class="px-3 py-1.5 rounded-lg text-sm ' +
        (active ? 'bg-emerald-600 text-white' : disabled ? 'text-gray-300' : 'bg-white border hover:bg-gray-50') +
        '">' + label + '</button>';
    }
    html += btn('<i class="fas fa-angle-left"></i>', cur - 1, cur <= 1, false);
    var start = Math.max(1, cur - 2), end = Math.min(state.totalPages, cur + 2);
    if (start > 1) html += btn('1', 1, false, cur === 1);
    if (start > 2) html += '<span class="px-1 text-gray-400">…</span>';
    for (var i = start; i <= end; i++) html += btn(String(i), i, false, i === cur);
    if (end < state.totalPages - 1) html += '<span class="px-1 text-gray-400">…</span>';
    if (end < state.totalPages) html += btn(String(state.totalPages), state.totalPages, false, cur === state.totalPages);
    html += btn('<i class="fas fa-angle-right"></i>', cur + 1, cur >= state.totalPages, false);
    p.innerHTML = html;
    Array.prototype.forEach.call(p.querySelectorAll('button[data-page]'), function (b) {
      b.addEventListener('click', function () {
        var pg = parseInt(b.getAttribute('data-page'), 10);
        if (pg >= 1 && pg <= state.totalPages) { search(pg); window.scrollTo({ top: 0, behavior: 'smooth' }); }
      });
    });
  }

  // ---- 同期(トレース) ----
  function startSync() {
    if (!confirm('4つのDBから全求人を取得し、自社DBへ同期します。数分〜十数分かかる場合があります。実行しますか？')) return;
    $('syncBtn').disabled = true;
    fetch('/api/trace/start', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ trigger: 'manual' })
    }).then(function (r) { return r.json(); }).then(function (d) {
      if (!d.ok && d.error === 'already_running') {
        alert('すでに同期が実行中です。進捗を表示します。');
      }
      pollSync();
    }).catch(function () {
      $('syncBtn').disabled = false;
      alert('同期の開始に失敗しました');
    });
  }

  function pollSync() {
    if (syncTimer) clearInterval(syncTimer);
    var tick = function () {
      fetch('/api/trace/status').then(function (r) { return r.json(); }).then(function (d) {
        if (!d.job) { $('syncBar').classList.add('hidden'); $('syncBtn').disabled = false; return; }
        var job = d.job;
        $('syncBar').classList.remove('hidden');
        var states = (d.states || []).map(function (s) {
          var warn = (s.failedPages && s.failedPages > 0);
          var color = s.phase === 'error' ? 'text-red-600' : (s.phase === 'done' ? (warn ? 'text-amber-600' : 'text-emerald-700') : 'text-gray-600');
          var icon = s.phase === 'error' ? 'fa-circle-xmark' : (s.phase === 'done' ? (warn ? 'fa-triangle-exclamation' : 'fa-circle-check') : 'fa-circle-notch spin');
          return '<span class="' + color + '"><i class="fas ' + icon + ' mr-1"></i>' +
            esc(s.sourceLabel) + ': ' + esc(s.message || s.phase) + '</span>';
        }).join('');
        $('syncStates').innerHTML = states;

        if (job.status === 'running') {
          $('syncSummary').textContent = '同期中… 取得 ' + (job.totalUpserted || 0).toLocaleString() + '件';
          $('syncBtn').disabled = true;
        } else {
          clearInterval(syncTimer); syncTimer = null;
          $('syncSummary').innerHTML = '<i class="fas fa-circle-check text-emerald-600 mr-1"></i>同期完了：更新 ' +
            (job.totalUpserted || 0).toLocaleString() + '件 / 新規 ' + (job.totalAdded || 0).toLocaleString() +
            '件 / 掲載終了 ' + (job.totalClosed || 0).toLocaleString() + '件';
          $('syncBtn').disabled = false;
          loadFacets();
          search(1);
          setTimeout(function () { $('syncBar').classList.add('hidden'); }, 8000);
        }
      }).catch(function () {});
    };
    tick();
    syncTimer = setInterval(tick, 3000);
  }

  // ---- 初期化 ----
  document.addEventListener('DOMContentLoaded', function () {
    loadFacets();
    search(1);
    $('searchBtn').addEventListener('click', function () { search(1); });
    $('resetBtn').addEventListener('click', function () {
      ['f-keyword', 'f-category', 'f-industry', 'f-employment', 'f-location', 'f-position',
       'f-salaryMin', 'f-salaryMax', 'f-age', 'f-education'].forEach(function (id) { if ($(id)) $(id).value = ''; });
      $('f-source').value = ''; $('f-sort').value = 'updated';
      if ($('f-gender')) $('f-gender').value = '';
      if ($('f-rewardType')) $('f-rewardType').value = '';
      $('f-openState').value = 'open';
      search(1);
    });
    $('f-sort').addEventListener('change', function () { search(1); });
    $('f-openState').addEventListener('change', function () { search(1); });
    $('f-keyword').addEventListener('keydown', function (e) { if (e.key === 'Enter') search(1); });
    $('syncBtn').addEventListener('click', startSync);
    // 詳細モーダルの閉じる操作
    $('detailClose').addEventListener('click', closeDetail);
    $('detailModal').addEventListener('click', function (e) { if (e.target === $('detailModal')) closeDetail(); });
    document.addEventListener('keydown', function (e) { if (e.key === 'Escape') closeDetail(); });
    // 起動時に実行中の同期があれば進捗表示を復帰
    fetch('/api/trace/status').then(function (r) { return r.json(); }).then(function (d) {
      if (d.job && d.job.status === 'running') pollSync();
    }).catch(function () {});
  });
})();
