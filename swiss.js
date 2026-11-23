/* Swiss: the calm search engine inside Stick Hubs.
   Searches Stick Hubs itself, then Wikipedia (free, no key), and offers the whole web on DuckDuckGo. */
(function () {
  var PAGES = [
    ['Game Hub', 'games.html', 'All the games on Stick Hubs. Play right in your browser.', 'games play hub arcade'],
    ['SmartLearning', 'smartlearning.html', 'A quiz for up to 32 players. Host a room, friends scan the QR code or type the code. Teachers can make their own quizzes.', 'quiz school teacher learn class questions trivia'],
    ['Battle Chess', 'battle-chess.html', 'A chess game with stickman armies.', 'chess board strategy'],
    ['Sort It!', 'sort-it.html', 'A relaxing puzzle game.', 'puzzle sort brain'],
    ['Stick Physics', 'physics.html', 'A physics playground: balls, boxes, planks and stickmen, pins and motors.', 'physics science sandbox'],
    ['Physics Playground', 'physics-playground.html', 'Run, jump, drop crates and bounce balls.', 'physics platformer'],
    ['Age of War Mobile', 'age-of-war.html', 'Train units through the Stone Age, Medieval and Modern ages.', 'war strategy history'],
    ['Stick Legions II', 'play.html', 'Build an army and destroy the enemy statue.', 'stick legions strategy war army'],
    ['Web Store', 'store.html', 'Download SwiftNet, the Stick Hubs web browser, and Stick Lab for Windows and Mac.', 'download apps swiftnet browser store windows mac'],
    ['Stick Lab', 'stick-lab.html', 'Make your own games with blocks, like Scratch.', 'make games code coding scratch blocks create'],
    ['YouTube', 'youtube.html', 'Videos: trailers, gameplay and how things are made.', 'videos watch youtube tv'],
    ['Animation', 'animation.html', 'Animated films.', 'movies films cartoon animation watch'],
    ['Books', 'books.html', 'Books to read.', 'books read stories reading'],
    ['Forum', 'forum.html', 'Updates, ideas, bugs and tips.', 'forum talk discuss help'],
    ['Community', 'community.html', 'Play with friends and share.', 'community friends share'],
    ['Friends', 'friends.html', 'Add friends and chat with them.', 'friends chat message'],
    ['Your account', 'account.html', 'Sign in and change your profile.', 'account sign in login profile settings'],
    ['Links', 'links.html', 'Useful links.', 'links']
  ];

  function esc(s) { return String(s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }

  function searchSite(q) {
    var words = q.toLowerCase().split(/\s+/).filter(Boolean);
    return PAGES.map(function (p) {
      var title = p[0].toLowerCase(), hay = (p[0] + ' ' + p[2] + ' ' + p[3]).toLowerCase(), score = 0;
      words.forEach(function (w) {
        if (title.indexOf(w) >= 0) score += 5;
        else if (hay.indexOf(w) >= 0) score += 2;
      });
      return { p: p, score: score };
    }).filter(function (r) { return r.score > 0; })
      .sort(function (a, b) { return b.score - a.score; })
      .slice(0, 4).map(function (r) { return r.p; });
  }

  function wikiLang() {
    var l = (document.documentElement.lang || 'en').slice(0, 2).toLowerCase();
    return /^[a-z]{2}$/.test(l) ? l : 'en';
  }

  function strip(html) { var d = document.createElement('div'); d.innerHTML = html; return d.textContent; }

  function box(opts) {
    opts = opts || {};
    var f = document.createElement('form');
    f.className = 'swiss-box' + (opts.big ? ' big' : '');
    f.action = 'swiss.html'; f.method = 'get'; f.setAttribute('role', 'search');
    f.innerHTML = '<input type="search" name="q" autocomplete="off" aria-label="Search with Swiss" placeholder="Search with Swiss">' +
      '<button type="submit"><svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true"><circle cx="10.5" cy="10.5" r="6.5" fill="none" stroke="currentColor" stroke-width="2.6"/><path d="M15.5 15.5 L21 21" stroke="currentColor" stroke-width="2.8" stroke-linecap="round"/></svg><span>Search</span></button>';
    if (opts.value) f.q.value = opts.value;
    return f;
  }

  function results(el, q) {
    if (!q) { el.innerHTML = ''; return; }
    var site = searchSite(q), html = '';
    if (site.length) {
      html += '<h2>On Stick Hubs</h2><ol class="sw-list">' + site.map(function (p) {
        return '<li><a href="' + p[1] + '">' + esc(p[0]) + '</a><span class="sw-url">stick-hubs.github.io/' + p[1] + '</span><p>' + esc(p[2]) + '</p></li>';
      }).join('') + '</ol>';
    }
    html += '<div id="sw-answer"></div><h2>From Wikipedia</h2><ol class="sw-list" id="sw-wiki"><li class="sw-wait">Searching…</li></ol>' +
      '<p class="sw-web">Didn’t find it? <a href="https://duckduckgo.com/?q=' + encodeURIComponent(q) + '" target="_blank" rel="noopener">Search the whole web for “' + esc(q) + '”</a></p>';
    el.innerHTML = html;

    var lang = wikiLang(), base = 'https://' + lang + '.wikipedia.org';
    fetch(base + '/w/api.php?action=query&list=search&format=json&origin=*&srlimit=6&srsearch=' + encodeURIComponent(q))
      .then(function (r) { return r.json(); })
      .then(function (d) {
        var hits = (d.query && d.query.search) || [], ul = document.getElementById('sw-wiki');
        if (!hits.length) { ul.innerHTML = '<li class="sw-wait">No Wikipedia articles found.</li>'; return; }
        ul.innerHTML = hits.map(function (h) {
          var url = base + '/wiki/' + encodeURIComponent(h.title.replace(/ /g, '_'));
          return '<li><a href="' + url + '" target="_blank" rel="noopener">' + esc(h.title) + '</a><span class="sw-url">' + lang + '.wikipedia.org</span><p>' + esc(strip(h.snippet)) + '…</p></li>';
        }).join('');
        return fetch(base + '/api/rest_v1/page/summary/' + encodeURIComponent(hits[0].title.replace(/ /g, '_')))
          .then(function (r) { return r.json(); })
          .then(function (s) {
            if (!s.extract || s.type === 'disambiguation') return;
            var img = s.thumbnail ? '<img src="' + esc(s.thumbnail.source) + '" alt="">' : '';
            document.getElementById('sw-answer').innerHTML = '<div class="sw-card">' + img + '<div><h3>' + esc(s.title) + '</h3><p>' + esc(s.extract) + '</p><a href="' + esc(s.content_urls.desktop.page) + '" target="_blank" rel="noopener">Read more on Wikipedia</a></div></div>';
          });
      })
      .catch(function () {
        var ul = document.getElementById('sw-wiki');
        if (ul) ul.innerHTML = '<li class="sw-wait">Couldn’t reach Wikipedia. Check your internet and try again.</li>';
      });
  }

  window.Swiss = { box: box, results: results };
})();
