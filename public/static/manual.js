// 手動検索モード フロントJS
// 自社DB(jobs)を /api/manual/jobs で検索し、/api/trace/* で同期を制御する。
(function () {
  'use strict';

  var state = { page: 1, pageSize: 20, totalPages: 1 };
  var syncTimer = null;

  function $(id) { return document.getElementById(id); }
  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }
  function srcClass(s) {
    return ({ circus: 'src-circus', hitolink: 'src-hitolink', jobins: 'src-jobins', kintone: 'src-kintone' })[s] || 'src-circus';
  }
  function salaryText(lo, hi) {
    if (lo == null && hi == null) return '応相談';
    if (lo != null && hi != null) return lo + '〜' + hi + '万円';
    if (lo != null) return lo + '万円〜';
    return '〜' + hi + '万円';
  }

  // ---- ファセット(選択肢)読み込み ----
  function loadFacets() {
    fetch('/api/manual/facets').then(function (r) { return r.json(); }).then(function (d) {
      // 媒体プルダウン
      var sel = $('f-source');
      if (d.sources) {
        Object.keys(d.sources).forEach(function (s) {
          var info = d.sources[s];
          var opt = document.createElement('option');
          opt.value = s;
          opt.textContent = info.label + '（掲載中 ' + (info.open || 0).toLocaleString() + '件）';
          sel.appendChild(opt);
        });
      }
      fillDatalist('dl-category', d.categories);
      fillDatalist('dl-industry', d.industries);
      fillDatalist('dl-employment', d.employments);
    }).catch(function () {});
  }
  function fillDatalist(id, arr) {
    var dl = $(id); if (!dl || !arr) return;
    dl.innerHTML = '';
    arr.slice(0, 200).forEach(function (v) {
      var o = document.createElement('option'); o.value = v; dl.appendChild(o);
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
    var smin = $('f-salaryMin').value; if (smin) params.set('salaryMin', smin);
    var smax = $('f-salaryMax').value; if (smax) params.set('salaryMax', smax);
    params.set('openOnly', $('f-openOnly').checked ? '1' : '0');
    params.set('sort', $('f-sort').value);
    params.set('page', state.page);
    params.set('pageSize', state.pageSize);

    $('results').innerHTML = '<div class="text-center text-gray-400 py-16"><i class="fas fa-circle-notch spin text-3xl"></i></div>';
    $('emptyState').classList.add('hidden');

    fetch('/api/manual/jobs?' + params.toString()).then(function (r) { return r.json(); }).then(function (d) {
      state.totalPages = d.totalPages || 1;
      $('resultCount').textContent = (d.total || 0).toLocaleString();
      renderResults(d.jobs || []);
      renderPager();
    }).catch(function () {
      $('results').innerHTML = '<div class="text-center text-red-400 py-16">読み込みに失敗しました</div>';
    });
  }

  function renderResults(jobs) {
    var box = $('results');
    if (!jobs.length) {
      box.innerHTML = '';
      $('emptyState').classList.remove('hidden');
      return;
    }
    box.innerHTML = jobs.map(function (j) {
      var locs = (j.locations || []).slice(0, 3).join('・');
      var closed = j.isOpen ? '' : '<span class="src-badge bg-gray-200 text-gray-500 ml-1">掲載終了</span>';
      var link = j.url
        ? '<a href="' + esc(j.url) + '" target="_blank" rel="noopener" class="text-emerald-600 hover:text-emerald-800 font-semibold text-sm"><i class="fas fa-arrow-up-right-from-square mr-1"></i>詳細を見る</a>'
        : '<span class="text-gray-300 text-sm">URLなし</span>';
      return '' +
        '<article class="job-card bg-white rounded-xl shadow-sm border border-gray-100 p-4">' +
          '<div class="flex items-start justify-between gap-3">' +
            '<div class="min-w-0">' +
              '<div class="flex items-center gap-2 mb-1 flex-wrap">' +
                '<span class="src-badge ' + srcClass(j.source) + '">' + esc(j.sourceLabel) + '</span>' +
                closed +
                (j.jobCategory ? '<span class="text-xs text-gray-500">' + esc(j.jobCategory) + '</span>' : '') +
              '</div>' +
              '<h3 class="font-bold text-gray-800 truncate">' + esc(j.title || '(無題)') + '</h3>' +
              '<p class="text-sm text-gray-500 truncate">' + esc(j.company || '') + '</p>' +
            '</div>' +
            '<div class="text-right shrink-0">' +
              '<div class="text-emerald-700 font-bold">' + salaryText(j.salaryMin, j.salaryMax) + '</div>' +
              (j.employment ? '<div class="text-xs text-gray-400">' + esc(j.employment) + '</div>' : '') +
            '</div>' +
          '</div>' +
          '<div class="mt-2 text-sm text-gray-600 line-clamp-2" style="display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden">' +
            esc((j.description || '').slice(0, 160)) +
          '</div>' +
          '<div class="mt-3 flex items-center justify-between text-xs text-gray-400">' +
            '<span>' + (locs ? '<i class="fas fa-location-dot mr-1"></i>' + esc(locs) : '') + '</span>' +
            link +
          '</div>' +
        '</article>';
    }).join('');
  }

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
          var color = s.phase === 'done' ? 'text-emerald-700' : s.phase === 'error' ? 'text-red-600' : 'text-gray-600';
          var icon = s.phase === 'done' ? 'fa-circle-check' : s.phase === 'error' ? 'fa-circle-xmark' : 'fa-circle-notch spin';
          return '<span class="' + color + '"><i class="fas ' + icon + ' mr-1"></i>' +
            esc(s.sourceLabel) + ': ' + esc(s.message || s.phase) +
            (s.upserted ? '（' + s.upserted.toLocaleString() + '件）' : '') + '</span>';
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
      ['f-keyword', 'f-category', 'f-industry', 'f-employment', 'f-location', 'f-salaryMin', 'f-salaryMax'].forEach(function (id) { $(id).value = ''; });
      $('f-source').value = ''; $('f-sort').value = 'updated'; $('f-openOnly').checked = true;
      search(1);
    });
    $('f-sort').addEventListener('change', function () { search(1); });
    $('f-keyword').addEventListener('keydown', function (e) { if (e.key === 'Enter') search(1); });
    $('syncBtn').addEventListener('click', startSync);
    // 起動時に実行中の同期があれば進捗表示を復帰
    fetch('/api/trace/status').then(function (r) { return r.json(); }).then(function (d) {
      if (d.job && d.job.status === 'running') pollSync();
    }).catch(function () {});
  });
})();
