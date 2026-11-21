// Stick Hubs accounts (sign in with GitHub). Shared by every page: shows the account button in the header
// and gives pages window.SH to talk to the Stick Hubs server.
(function () {
  var SESSION_KEY = 'stick-hubs-session';
  var CACHE_KEY = 'stick-hubs-account';
  var configPromise = null;

  function readJson(key) { try { return JSON.parse(localStorage.getItem(key) || 'null'); } catch (e) { return null; } }
  function write(key, value) { try { if (value == null) localStorage.removeItem(key); else localStorage.setItem(key, typeof value === 'string' ? value : JSON.stringify(value)); } catch (e) {} }

  // A fresh sign-in comes back as #session=... on the page we started from.
  var m = /[#&]session=([a-z0-9]{20,80})/i.exec(location.hash);
  if (m) {
    write(SESSION_KEY, m[1]);
    history.replaceState(null, '', location.pathname + location.search);
  }

  var SH = window.SH = {
    banners: {
      sky: 'linear-gradient(160deg, #5fb4f0 0%, #b9e2ff 60%, #e9f6ff 100%)',
      sunset: 'linear-gradient(160deg, #3a2a6b 0%, #e0706b 60%, #ffd08a 100%)',
      night: 'linear-gradient(160deg, #0b1030 0%, #27346b 70%, #5a4a9b 100%)',
      forest: 'linear-gradient(160deg, #1f5a2a 0%, #4caf50 60%, #c5e8a5 100%)',
      lava: 'linear-gradient(160deg, #3a0d0d 0%, #b8320f 55%, #ffb02e 100%)',
      ocean: 'linear-gradient(160deg, #06314f 0%, #1e88e5 60%, #8fe0f0 100%)'
    },
    accents: ['#2a6ab8', '#2f9a2a', '#e53935', '#fb8c00', '#8e24aa', '#00897b', '#f6b93b', '#455a64'],
    server: function () {
      if (!configPromise) {
        configPromise = fetch('lab/duo-config.json', {cache: 'no-cache'})
          .then(function (r) { return r.ok ? r.json() : {}; }).catch(function () { return {}; })
          .then(function (c) { return c.serverUrl ? c.serverUrl.replace(/\/$/, '') : null; });
      }
      return configPromise;
    },
    session: function () { try { return localStorage.getItem(SESSION_KEY); } catch (e) { return null; } },
    cached: function () { return SH.session() ? readJson(CACHE_KEY) : null; },
    // fetch to the server, with the session if signed in
    api: function (path, options) {
      options = options || {};
      return SH.server().then(function (server) {
        if (!server) throw new Error('Accounts aren\'t switched on yet.');
        var headers = options.headers || {};
        var token = SH.session();
        if (token) headers.authorization = 'Bearer ' + token;
        return fetch(server + path, {method: options.method || 'GET', headers: headers, body: options.body})
          .then(function (r) {
            return r.json().catch(function () { return {}; }).then(function (body) {
              if (r.status === 401) { write(SESSION_KEY, null); write(CACHE_KEY, null); }
              if (!r.ok) throw new Error(body.error || ('Error ' + r.status));
              return body;
            });
          });
      });
    },
    me: function () {
      if (!SH.session()) return Promise.resolve(null);
      return SH.api('/me').then(function (body) { write(CACHE_KEY, body.profile); renderChip(); return body.profile; });
    },
    remember: function (profile) { write(CACHE_KEY, profile); renderChip(); },
    signIn: function () {
      SH.server().then(function (server) {
        if (!server) { alert('Accounts aren\'t switched on yet.'); return; }
        location.href = server + '/auth/login?return=' + encodeURIComponent(location.origin + location.pathname);
      });
    },
    signOut: function () {
      var done = function () { write(SESSION_KEY, null); write(CACHE_KEY, null); renderChip(); };
      return SH.api('/auth/logout', {method: 'POST'}).then(done, done);
    },
    accountsOn: function () {
      return SH.server().then(function (server) {
        if (!server) return false;
        return fetch(server + '/auth/status').then(function (r) { return r.json(); })
          .then(function (b) { return !!b.accounts; }).catch(function () { return false; });
      });
    }
  };

  function renderChip() {
    var side = document.querySelector('.sm-side');
    if (!side) return;
    var chip = side.querySelector('.sm-account');
    if (!chip) {
      chip = document.createElement('a');
      chip.className = 'sm-account';
      var cta = side.querySelector('.sm-cta');
      side.insertBefore(chip, cta);
    }
    chip.textContent = '';
    var profile = SH.cached();
    chip.href = 'account.html';
    if (profile) {
      var img = document.createElement('img');
      img.alt = '';
      img.src = profile.avatar || 'icon-192.png';
      img.onerror = function () { img.src = 'icon-192.png'; };
      chip.appendChild(img);
      chip.appendChild(document.createTextNode(profile.displayName || profile.login));
      chip.title = 'Your Stick Hubs account';
      chip.style.setProperty('--acc', profile.accent || '#2a6ab8');
    } else {
      chip.appendChild(document.createTextNode('Sign in'));
      chip.title = 'Sign in with GitHub';
    }
    chip.hidden = false;
  }

  function ready(f) { if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', f); else f(); }
  ready(function () {
    SH.server().then(function (server) {
      if (!server) return; // no server: no account button
      if (SH.session()) {
        renderChip();
        SH.me().catch(function () { renderChip(); });
      } else {
        SH.accountsOn().then(function (on) { if (on) renderChip(); });
      }
    });
  });
})();
