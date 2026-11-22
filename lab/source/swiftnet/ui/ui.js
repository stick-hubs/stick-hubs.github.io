// SwiftNet browser frame: draws the tabs and toolbar, and tells the main process what was clicked.
(function () {
  'use strict';
  var S = window.swift;
  var $ = function (id) { return document.getElementById(id); };
  var state = null;
  var editing = false;
  var dlHidden = false;
  var platform = new URLSearchParams(location.search).get('platform') || '';
  if (platform === 'darwin') document.body.classList.add('mac');

  var GLOBE = '<svg viewBox="0 0 16 16"><circle cx="8" cy="8" r="6.3" fill="none" stroke="#5f7da1" stroke-width="1.3"/><path d="M1.8 8 H14.2 M8 1.7 C5.5 4.5 5.5 11.5 8 14.3 M8 1.7 C10.5 4.5 10.5 11.5 8 14.3" fill="none" stroke="#5f7da1" stroke-width="1.1"/></svg>';
  var SN = '<svg viewBox="0 0 32 32"><circle cx="16" cy="16" r="14" fill="#2a8fd8"/><path d="M5 19 C 11 13, 18 12, 28 9 C 21 14, 16 18, 9 26 C 10 22, 9 20, 5 19 Z" fill="#fff"/></svg>';
  var LOCK = '<svg viewBox="0 0 16 16"><rect x="3.2" y="7" width="9.6" height="7" rx="1.4" fill="#2e7d32"/><path d="M5.3 7 V5.2 A2.7 2.7 0 0 1 10.7 5.2 V7" fill="none" stroke="#2e7d32" stroke-width="1.6"/></svg>';
  var INFO = '<svg viewBox="0 0 16 16"><circle cx="8" cy="8" r="6.3" fill="none" stroke="#6b7280" stroke-width="1.4"/><path d="M8 7 V11.5 M8 4.6 V5" stroke="#6b7280" stroke-width="1.7" stroke-linecap="round"/></svg>';
  var WARN = '<svg viewBox="0 0 16 16"><path d="M8 1.8 L15 14 H1 Z" fill="#c62828"/><path d="M8 6 V9.6 M8 11.4 V11.8" stroke="#fff" stroke-width="1.6" stroke-linecap="round"/></svg>';
  var SPEAKER = '<svg class="audio" viewBox="0 0 16 16"><path d="M2.5 6 H5 L8.5 3 V13 L5 10 H2.5 Z" fill="currentColor"/><path d="M10.5 5.5 C11.8 6.8 11.8 9.2 10.5 10.5 M12.3 3.8 C14.6 6.1 14.6 9.9 12.3 12.2" fill="none" stroke="currentColor" stroke-width="1.3"/></svg>';
  var X = '<svg viewBox="0 0 10 10"><path d="M1.5 1.5 L8.5 8.5 M8.5 1.5 L1.5 8.5" stroke="currentColor" stroke-width="1.6"/></svg>';

  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return {'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[c]; }); }
  function safeImg(url) { return /^(https?:|data:image\/)/i.test(url || '') ? url : ''; }

  function prettyUrl(url) {
    if (!url) return '';
    if (/^swiftnet:\/\/error/.test(url)) {
      try { return new URL(url).searchParams.get('url') || url; } catch (e) { return url; }
    }
    return url;
  }

  // tell the main process how much room the frame takes, so pages go right below it
  function reportLayout() {
    var top = state && state.htmlFullscreen ? 0 : $('chrome').getBoundingClientRect().height;
    var bottom = $('downloads').hidden || (state && state.htmlFullscreen) ? 0 : $('downloads').getBoundingClientRect().height;
    S.layout(top, bottom);
  }
  new ResizeObserver(reportLayout).observe($('chrome'));

  // ---------- tabs ----------
  function renderTabs() {
    var box = $('tabs');
    var avail = document.body.clientWidth - (platform === 'darwin' ? 72 : 30) - 40 - 70 - (platform === 'darwin' ? 0 : 140);
    var w = Math.max(44, Math.min(220, Math.floor(avail / Math.max(1, state.tabs.length))));
    box.innerHTML = state.tabs.map(function (t) {
      var fav = t.loading ? '<span class="spin"></span>' :
        /^swiftnet:/.test(t.url) ? SN : (safeImg(t.favicon) ? '<img class="favimg" alt="" src="' + esc(safeImg(t.favicon)) + '">' : GLOBE);
      return '<div class="tab' + (t.id === state.active ? ' active' : '') + (w < 80 ? ' narrow' : '') + '" role="tab" draggable="true" aria-selected="' + (t.id === state.active) + '" data-id="' + t.id + '" title="' + esc(t.title) + '" style="width:' + w + 'px;flex-basis:' + w + 'px">' +
        '<span class="fav">' + fav + '</span><span class="title">' + esc(t.title || prettyUrl(t.url)) + '</span>' + (t.audible ? SPEAKER : '') +
        '<button class="x" data-close="' + t.id + '" title="Close tab (Ctrl+W)" aria-label="Close tab">' + X + '</button></div>';
    }).join('');
    box.querySelectorAll('img.favimg').forEach(function (img) {
      img.addEventListener('error', function () { img.outerHTML = GLOBE; });
    });
  }

  $('tabs').addEventListener('mousedown', function (e) {
    var tab = e.target.closest('.tab');
    if (!tab) return;
    var id = +tab.getAttribute('data-id');
    if (e.button === 1) { e.preventDefault(); S.command('closeTab', id); return; }
    if (e.button === 0 && !e.target.closest('[data-close]')) S.command('activate', id);
  });
  $('tabs').addEventListener('click', function (e) {
    var c = e.target.closest('[data-close]');
    if (c) S.command('closeTab', +c.getAttribute('data-close'));
  });
  $('tabs').addEventListener('dblclick', function (e) { if (!e.target.closest('.tab')) S.command('max'); });
  // drag tabs to reorder
  var dragId = null;
  $('tabs').addEventListener('dragstart', function (e) {
    var tab = e.target.closest('.tab');
    if (!tab) return;
    dragId = +tab.getAttribute('data-id');
    tab.classList.add('dragging');
    e.dataTransfer.effectAllowed = 'move';
  });
  $('tabs').addEventListener('dragover', function (e) { if (dragId) e.preventDefault(); });
  $('tabs').addEventListener('drop', function (e) {
    e.preventDefault();
    if (!dragId) return;
    var tabs = Array.prototype.slice.call($('tabs').children);
    var index = tabs.length - 1;
    for (var i = 0; i < tabs.length; i++) {
      var r = tabs[i].getBoundingClientRect();
      if (e.clientX < r.left + (r.width / 2)) { index = i; break; }
    }
    var from = state.tabs.findIndex(function (t) { return t.id === dragId; });
    if (index > from) index--;
    S.command('moveTab', {id: dragId, index: index});
    dragId = null;
  });
  $('tabs').addEventListener('dragend', function () { dragId = null; renderTabs(); });
  $('newtab').addEventListener('click', function () { S.command('newTab'); });
  $('titlebar').addEventListener('dblclick', function (e) { if (e.target === $('titlebar') || e.target.classList.contains('drag')) S.command('max'); });

  // ---------- toolbar ----------
  document.addEventListener('click', function (e) {
    var b = e.target.closest('[data-cmd]');
    if (b && !b.disabled) S.command(b.getAttribute('data-cmd'));
  });
  $('menu').addEventListener('click', function () {
    var r = $('menu').getBoundingClientRect();
    S.command('menu', {x: Math.round(r.right - 230), y: Math.round(r.bottom)});
  });

  var address = $('address');
  address.addEventListener('focus', function () { editing = true; setTimeout(function () { address.select(); }, 0); });
  address.addEventListener('blur', function () { editing = false; renderAddress(); });
  address.addEventListener('keydown', function (e) {
    if (e.key === 'Enter') {
      var text = address.value.trim();
      if (!text) return;
      if (e.ctrlKey && !/[.\s/]/.test(text)) text = 'www.' + text + '.com'; // Ctrl+Enter, like other browsers
      S.command('navigate', text);
      address.blur();
    } else if (e.key === 'Escape') {
      address.value = prettyUrl(state && state.url);
      address.select();
    }
  });

  function renderAddress() {
    var url = state ? state.url : '';
    var omni = $('omnibox');
    omni.classList.toggle('secure', /^https:/.test(url));
    var sec = $('security');
    if (/^https:/.test(url)) { sec.innerHTML = LOCK; sec.title = 'Connection is secure'; }
    else if (/^swiftnet:\/\/error/.test(url)) { sec.innerHTML = WARN; sec.title = 'This page could not be loaded'; }
    else if (/^swiftnet:/.test(url)) { sec.innerHTML = SN; sec.title = 'SwiftNet page'; }
    else if (/^http:/.test(url)) { sec.innerHTML = INFO; sec.title = 'Not secure: information sent to this site could be read by others'; }
    else { sec.innerHTML = INFO; sec.title = ''; }
    if (!editing) address.value = prettyUrl(url);
    address.placeholder = 'Search ' + ((state && state.searchName) || 'the web') + ' or type a web address';
  }

  // ---------- bookmarks bar ----------
  function renderBookmarks() {
    var bar = $('bookmarks');
    if (!state.bookmarks) { bar.hidden = true; document.body.classList.remove('has-bookmarks'); return; }
    bar.hidden = false;
    document.body.classList.add('has-bookmarks');
    bar.innerHTML = state.bookmarks.length ? state.bookmarks.map(function (b, i) {
      var host = '';
      try { host = new URL(b.url).hostname; } catch (e) {}
      return '<button class="bm" data-bm="' + i + '" title="' + esc(b.title + '\n' + b.url) + '">' + GLOBE + '<span>' + esc(b.title || host) + '</span></button>';
    }).join('') : '<span class="bm-empty">Press the star in the address bar to add bookmarks here.</span>';
  }
  $('bookmarks').addEventListener('click', function (e) {
    var b = e.target.closest('[data-bm]');
    if (!b) return;
    var bm = state.bookmarks[+b.getAttribute('data-bm')];
    if (e.ctrlKey || e.metaKey) S.command('open', bm.url); else S.command('navigate', bm.url);
  });
  $('bookmarks').addEventListener('auxclick', function (e) {
    var b = e.target.closest('[data-bm]');
    if (b && e.button === 1) S.command('open', state.bookmarks[+b.getAttribute('data-bm')].url);
  });
  $('bookmarks').addEventListener('contextmenu', function (e) {
    var b = e.target.closest('[data-bm]');
    if (b) { e.preventDefault(); S.bookmarkMenu(+b.getAttribute('data-bm')); }
  });

  // ---------- find bar ----------
  var findText = $('findtext');
  function find(forward, next) {
    var t = findText.value;
    if (!t) { S.find(''); $('findcount').textContent = ''; findText.classList.remove('none'); return; }
    S.find(t, {forward: forward, findNext: !!next});
  }
  findText.addEventListener('input', function () { find(true, false); });
  findText.addEventListener('keydown', function (e) {
    if (e.key === 'Enter') find(!e.shiftKey, true);
    else if (e.key === 'Escape') closeFind();
  });
  $('findnext').addEventListener('click', function () { find(true, true); });
  $('findprev').addEventListener('click', function () { find(false, true); });
  $('findclose').addEventListener('click', closeFind);
  function closeFind() { $('findbar').hidden = true; S.find(''); }
  S.on('find:show', function () { $('findbar').hidden = false; findText.focus(); findText.select(); if (findText.value) find(true, false); });
  S.on('find:hide', function () { if (!$('findbar').hidden) closeFind(); });
  S.on('find:result', function (r) {
    $('findcount').textContent = r.total ? r.match + ' of ' + r.total : 'No matches';
    findText.classList.toggle('none', !r.total);
  });
  S.on('focus:address', function () { address.focus(); address.select(); });

  // ---------- downloads bar ----------
  function size(n) {
    if (!n) return '0 B';
    var u = ['B', 'KB', 'MB', 'GB'];
    var i = Math.min(3, Math.floor(Math.log(n) / Math.log(1024)));
    return (n / Math.pow(1024, i)).toFixed(i ? 1 : 0) + ' ' + u[i];
  }
  var lastDlIds = '';
  function renderDownloads() {
    var list = state.downloads || [];
    var ids = list.map(function (d) { return d.id; }).join(',');
    if (ids !== lastDlIds && list.some(function (d) { return lastDlIds.split(',').indexOf(String(d.id)) < 0; })) dlHidden = false;
    lastDlIds = ids;
    var bar = $('downloads');
    var show = list.length && !dlHidden;
    bar.hidden = !show;
    if (show) {
      bar.innerHTML = list.map(function (d) {
        var pct = d.total ? Math.round(100 * d.received / d.total) : 0;
        var status = d.state === 'completed' ? size(d.received) + ' &middot; Done' : d.state === 'cancelled' ? 'Cancelled' : d.state === 'interrupted' ? 'Failed' :
          (d.paused ? 'Paused &middot; ' : '') + size(d.received) + (d.total ? ' of ' + size(d.total) : '');
        var actions = d.state === 'completed' ? '<button data-dl="open" data-id="' + d.id + '" title="Open">&#8599;</button><button data-dl="show" data-id="' + d.id + '" title="Show in folder">&#128193;</button>' :
          d.state === 'progressing' ? '<button data-dl="pause" data-id="' + d.id + '" title="' + (d.paused ? 'Resume' : 'Pause') + '">' + (d.paused ? '&#9654;' : '&#10073;&#10073;') + '</button><button data-dl="cancel" data-id="' + d.id + '" title="Cancel">' + X + '</button>' : '';
        return '<div class="dl"><svg class="ic" viewBox="0 0 26 26"><path d="M6 2 H16 L21 7 V24 H6 Z" fill="#fff" stroke="#7d8fa6"/><path d="M16 2 V7 H21" fill="none" stroke="#7d8fa6"/><path d="M13.5 10 V19 M10 15.5 L13.5 19 L17 15.5" fill="none" stroke="#2a8fd8" stroke-width="1.8"/></svg>' +
          '<div class="info"><div class="nm" title="' + esc(d.name) + '">' + esc(d.name) + '</div><div class="st">' + status + '</div>' +
          (d.state === 'progressing' ? '<div class="bar"><i style="width:' + pct + '%"></i></div>' : '') + '</div>' + actions + '</div>';
      }).join('') + '<button id="dl-all" title="See all downloads">Show all</button><button id="dl-close" title="Close" aria-label="Close downloads bar">' + X + '</button>';
    }
    reportLayout();
  }
  $('downloads').addEventListener('click', function (e) {
    var b = e.target.closest('[data-dl]');
    if (b) { S.download(b.getAttribute('data-dl'), +b.getAttribute('data-id')); return; }
    if (e.target.closest('#dl-close')) { dlHidden = true; renderDownloads(); return; }
    if (e.target.closest('#dl-all')) { e.stopPropagation(); S.command('page', 'downloads'); }
  }, true);

  // ---------- everything ----------
  S.on('state', function (s) {
    state = s;
    document.body.classList.toggle('aero', s.theme !== 'modern');
    document.body.classList.toggle('modern', s.theme === 'modern');
    document.body.classList.toggle('full', !!s.htmlFullscreen);
    document.body.classList.toggle('blur', !s.focused);
    renderTabs();
    renderAddress();
    renderBookmarks();
    renderDownloads();
    $('back').disabled = !s.canBack;
    $('forward').disabled = !s.canForward;
    $('reload').classList.toggle('loading', !!s.loading);
    $('reload').title = s.loading ? 'Stop (Esc)' : 'Reload (F5)';
    $('star').classList.toggle('on', !!s.bookmarked);
    $('star').title = s.bookmarked ? 'Remove bookmark (Ctrl+D)' : 'Bookmark this page (Ctrl+D)';
    $('star').hidden = !/^https?:/.test(s.url);
    $('zoom').hidden = s.zoom === 100;
    $('zoom').textContent = s.zoom + '%';
    $('claude').classList.toggle('on', !!s.claudeOpen);
    $('update').hidden = !s.update;
    if (s.update) { $('update').textContent = 'Update to ' + s.update.version; $('update').title = s.update.notes || 'A new SwiftNet is out'; }
    var maxBtn = document.querySelector('[data-cmd=max]');
    maxBtn.title = s.maximized ? 'Restore down' : 'Maximize';
    maxBtn.innerHTML = s.maximized ? '<svg viewBox="0 0 10 10"><rect x="1" y="3" width="6" height="6" fill="none" stroke="currentColor" stroke-width="1.2"/><path d="M3 3 V1 H9 V7 H7" fill="none" stroke="currentColor" stroke-width="1.2"/></svg>' :
      '<svg viewBox="0 0 10 10"><rect x="1.2" y="1.2" width="7.6" height="7.6" fill="none" stroke="currentColor" stroke-width="1.3"/></svg>';
    reportLayout();
  });
  window.addEventListener('resize', function () { if (state) renderTabs(); });
  S.ready();
  reportLayout();
})();
