/* Web Store: apps made by the Stick Hubs community (approved by the owner first). */
(function () {
  var PLAT = { web: 'Web', windows: 'Windows', mac: 'Mac', linux: 'Linux', android: 'Android', ios: 'iPhone/iPad' };
  var CAT = { game: 'Game', education: 'Education', tool: 'Tool', creative: 'Creative', browser: 'Browser', other: 'Other' };
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function stars(n) { var full = Math.round(n); return '<span class="stars" title="' + n + ' of 5">' + '★★★★★'.slice(0, full) + '<span class="off">' + '★★★★★'.slice(full) + '</span></span>'; }
  function ready(f) { if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', f); else f(); }

  function card(a, mine) {
    return '<article class="app capp" id="app-' + esc(a.id) + '"><div class="app-head"><img src="' + esc(a.icon) + '" alt="" width="64" height="64" loading="lazy"><div><h3>' + esc(a.name) + '</h3>' +
      '<span class="app-meta">' + esc(CAT[a.category] || 'App') + ' · by <a href="profile.html?u=' + encodeURIComponent(a.owner) + '">@' + esc(a.owner) + '</a>' +
      (a.votes ? ' · ' + stars(a.stars) + ' (' + a.votes + ')' : '') + '</span>' +
      (mine ? ' <span class="status-' + esc(a.status) + '">' + ({ pending: 'Waiting for the owner to check', approved: 'In the Web Store', rejected: 'Not approved' }[a.status] || a.status) + '</span>' : '') +
      '</div></div>' +
      (a.tagline ? '<p><b>' + esc(a.tagline) + '</b></p>' : '') + (mine && a.note ? '<p class="small">Owner\'s note: ' + esc(a.note) + '</p>' : '') +
      '<p class="plats">' + a.platforms.map(function (p) { return '<span>' + esc(PLAT[p] || p) + '</span>'; }).join('') + '</p>' +
      '<details><summary>More about this app</summary><p class="desc">' + esc(a.description).replace(/\n/g, '<br>') + '</p>' +
      (a.shots.length ? '<div class="shots">' + a.shots.map(function (s) { return '<a href="' + esc(s) + '" target="_blank" rel="noopener"><img src="' + esc(s) + '" alt="Screenshot" loading="lazy"></a>'; }).join('') + '</div>' : '') +
      (mine ? '' : '<div class="rate" data-id="' + esc(a.id) + '">Rate it: ' + [1, 2, 3, 4, 5].map(function (n) { return '<button data-star="' + n + '" aria-label="' + n + ' stars">★</button>'; }).join('') +
        ' <a href="#" class="report" data-id="' + esc(a.id) + '">Report this app</a></div>') + '</details>' +
      '<div class="btns">' + (mine ? '<a class="btn" href="store-submit.html?edit=' + esc(a.id) + '">Edit</a><button class="btn del" data-id="' + esc(a.id) + '">Delete</button>' :
        '<a class="btn play get" href="' + esc(a.url) + '" target="_blank" rel="noopener nofollow" data-owner="' + esc(a.owner) + '">' + (a.platforms.length === 1 && a.platforms[0] === 'web' ? 'Open' : 'Get it') + '</a>') + '</div></article>';
  }

  function list(box, apps, mine) {
    box.innerHTML = apps.length ? apps.map(function (a) { return card(a, mine); }).join('') : '<p class="small">' + (mine ? 'You haven\'t sent any apps yet.' : 'No community apps yet. Be the first!') + '</p>';
  }

  function wire(box) {
    box.addEventListener('click', function (e) {
      var get = e.target.closest('.get');
      if (get && !confirm('This app is made by @' + get.getAttribute('data-owner') + ', not by Stick Hubs. You\'ll go to their website.\n\nOnly download things you trust, and ask a grown-up if you\'re not sure. Continue?')) { e.preventDefault(); return; }
      var star = e.target.closest('[data-star]');
      if (star) {
        if (!SH.session()) { alert('Sign in to rate apps.'); return; }
        var id = star.parentNode.getAttribute('data-id');
        SH.api('/store/rate', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: id, stars: +star.getAttribute('data-star') }) })
          .then(function (r) { star.parentNode.querySelectorAll('[data-star]').forEach(function (b) { b.classList.toggle('on', +b.getAttribute('data-star') <= +star.getAttribute('data-star')); }); star.parentNode.insertAdjacentHTML('beforeend', ' <span class="small">Thanks! Now ' + r.stars + ' ★</span>'); }, function (err) { alert(err.message); });
      }
      var rep = e.target.closest('.report');
      if (rep) {
        e.preventDefault();
        if (!SH.session()) { alert('Sign in to report an app.'); return; }
        var why = prompt('What\'s wrong with this app?');
        if (!why) return;
        SH.api('/store/report', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: rep.getAttribute('data-id'), reason: why }) })
          .then(function (r) { alert(r.message); }, function (err) { alert(err.message); });
      }
      var del = e.target.closest('.del');
      if (del && confirm('Delete this app from the Web Store?')) {
        SH.api('/store/delete', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: del.getAttribute('data-id') }) })
          .then(function () { var art = del.closest('.capp'); art.parentNode.removeChild(art); }, function (err) { alert(err.message); });
      }
    });
  }

  // ---------- owner tools: store.html?owner
  function owner(box) {
    var pass = ''; try { pass = JSON.parse(localStorage.getItem('stick-lab-duo-settings') || '{}').ownerPass || ''; } catch (e) { /* none */ }
    if (!pass) { box.innerHTML = '<p>Owner tools need your owner pass. Add it in Stick Lab → Duo settings first.</p>'; return; }
    function call(body) {
      SH.server().then(function (base) {
        return fetch(base + '/owner/store', { method: 'POST', headers: { 'content-type': 'application/json', 'x-duo-owner': pass }, body: JSON.stringify(body || {}) });
      }).then(function (r) { return r.json(); }).then(draw, function () { box.innerHTML = '<p>Couldn\'t reach the server.</p>'; });
    }
    function draw(d) {
      if (d.error) { box.innerHTML = '<p>' + esc(d.error) + '</p>'; return; }
      box.innerHTML = '<h3>Apps waiting for you (' + d.pending.length + ')</h3>' + (d.pending.length ? d.pending.map(function (a) {
        return card(a, false).replace('<div class="btns">', '<div class="btns"><button class="btn play" data-act="approve" data-id="' + esc(a.id) + '">Approve</button><button class="btn" data-act="reject" data-id="' + esc(a.id) + '">Say no</button>');
      }).join('') : '<p class="small">Nothing to check.</p>') +
        '<h3>Reports</h3>' + (d.reports.length ? '<ul>' + d.reports.map(function (r) {
          return '<li><b>' + esc(r.name || r.app) + '</b> by report from @' + esc(r.login) + ': ' + esc(r.reason) + ' <button class="btn" data-act="remove" data-id="' + esc(r.app) + '">Remove app</button> <button class="btn" data-act="dismiss" data-report="' + r.id + '">Dismiss</button></li>';
        }).join('') + '</ul>' : '<p class="small">No reports.</p>') +
        '<h3>WorkSheet++ question reports</h3>' + (d.feedback.length ? '<ul>' + d.feedback.map(function (f) { return '<li>@' + esc(f.login) + ' · ' + esc(f.course) + ': ' + esc(f.question) + ' — <i>' + esc(f.note) + '</i></li>'; }).join('') + '</ul>' : '<p class="small">None.</p>');
    }
    box.addEventListener('click', function (e) {
      var b = e.target.closest('[data-act]');
      if (!b) return;
      var act = b.getAttribute('data-act'), body = { action: act, id: b.getAttribute('data-id'), report: b.getAttribute('data-report') };
      if (act === 'reject') { body.note = prompt('Why not? (the maker will see this)') || ''; }
      if (act === 'remove' && !confirm('Remove this app from the Web Store for good?')) return;
      call(body);
    });
    call();
  }

  ready(function () {
    var box = document.getElementById('community');
    if (box) {
      wire(box);
      SH.api('/store/apps').then(function (r) { if (r.off) box.innerHTML = '<p class="small">Community apps are coming soon.</p>'; else list(box, r.apps, false); },
        function () { box.innerHTML = '<p class="small">Community apps are coming soon.</p>'; });
    }
    var own = document.getElementById('storeowner');
    if (own && /[?&]owner\b/.test(location.search)) { own.hidden = false; owner(own); }
  });
  window.StoreCommunity = { card: card, list: list, wire: wire };
})();
