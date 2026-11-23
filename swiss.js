/* Swiss: the calm search engine inside Stick Hubs.
   Results come from Swiss's own index (read by SwissBot on the Stick Hubs server), from Stick Hubs itself,
   and from free open sources: Wikipedia, Open-Meteo (weather), Free Dictionary, Open Library (books)
   and OpenStreetMap (places). Nothing sends you to another search engine. */
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
    ['Swiss', 'swiss.html', 'The Stick Hubs search engine.', 'swiss search engine']
  ];
  var STOP = /^(the|a|an|of|in|on|for|to|and|is|what|how|who|where|me|my|please)$/i;

  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }
  function $(id) { return document.getElementById(id); }
  function getJson(url) { return fetch(url).then(function (r) { if (!r.ok) throw new Error(r.status); return r.json(); }); }
  function strip(html) { var d = document.createElement('div'); d.innerHTML = html; return d.textContent; }
  function lang() { var l = (document.documentElement.lang || 'en').slice(0, 2).toLowerCase(); return /^[a-z]{2}$/.test(l) ? l : 'en'; }
  function hostOf(u) { try { return new URL(u).hostname.replace(/^www\./, ''); } catch (e) { return ''; } }

  var serverPromise = null;
  function server() {
    if (!serverPromise) {
      serverPromise = fetch('lab/duo-config.json', { cache: 'no-cache' })
        .then(function (r) { return r.ok ? r.json() : {}; }).catch(function () { return {}; })
        .then(function (c) { return c.serverUrl ? c.serverUrl.replace(/\/$/, '') : null; });
    }
    return serverPromise;
  }

  function searchSite(q) {
    var words = q.toLowerCase().split(/\s+/).filter(function (w) { return w && !STOP.test(w); });
    return PAGES.map(function (p) {
      var title = p[0].toLowerCase(), hay = (p[0] + ' ' + p[2] + ' ' + p[3]).toLowerCase(), score = 0;
      words.forEach(function (w) {
        if (title.indexOf(w) >= 0) score += 5;
        else if (hay.indexOf(w) >= 0) score += 2;
      });
      return { p: p, score: score };
    }).filter(function (r) { return r.score > 0; })
      .sort(function (a, b) { return b.score - a.score; })
      .slice(0, 3).map(function (r) { return r.p; });
  }

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

  // ------------------------------------------------------------ answer boxes
  var WMO = { 0: ['Clear sky', '☀️'], 1: ['Mostly clear', '🌤️'], 2: ['Partly cloudy', '⛅'], 3: ['Cloudy', '☁️'], 45: ['Fog', '🌫️'], 48: ['Fog', '🌫️'],
    51: ['Light drizzle', '🌦️'], 53: ['Drizzle', '🌦️'], 55: ['Heavy drizzle', '🌧️'], 61: ['Light rain', '🌦️'], 63: ['Rain', '🌧️'], 65: ['Heavy rain', '🌧️'],
    71: ['Light snow', '🌨️'], 73: ['Snow', '🌨️'], 75: ['Heavy snow', '❄️'], 80: ['Showers', '🌦️'], 81: ['Showers', '🌧️'], 82: ['Heavy showers', '⛈️'],
    95: ['Thunderstorm', '⛈️'], 96: ['Thunderstorm', '⛈️'], 99: ['Thunderstorm', '⛈️'] };
  function wmo(c) { return WMO[c] || ['', '🌡️']; }

  function geocode(place) {
    return getJson('https://geocoding-api.open-meteo.com/v1/search?count=1&language=' + lang() + '&name=' + encodeURIComponent(place))
      .then(function (d) { return d.results && d.results[0]; });
  }

  function weatherBox(place) {
    if (!place) return Promise.resolve('<div class="sw-card"><div><h3>Weather</h3><p>Add a city, for example <a href="swiss.html?q=weather+Jakarta">weather Jakarta</a>.</p></div></div>');
    return geocode(place).then(function (g) {
      if (!g) return '';
      return getJson('https://api.open-meteo.com/v1/forecast?latitude=' + g.latitude + '&longitude=' + g.longitude +
        '&current=temperature_2m,weather_code,wind_speed_10m,relative_humidity_2m&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max&timezone=auto&forecast_days=4')
        .then(function (w) {
          var c = w.current, now = wmo(c.weather_code), days = '';
          for (var i = 0; i < w.daily.time.length; i++) {
            var day = new Date(w.daily.time[i] + 'T12:00').toLocaleDateString(undefined, { weekday: 'short' });
            days += '<div class="sw-day"><b>' + esc(i ? day : 'Today') + '</b><span class="sw-emoji">' + wmo(w.daily.weather_code[i])[1] + '</span>' +
              Math.round(w.daily.temperature_2m_max[i]) + '° / ' + Math.round(w.daily.temperature_2m_min[i]) + '°<small>💧 ' + (w.daily.precipitation_probability_max[i] || 0) + '%</small></div>';
          }
          return '<div class="sw-card sw-weather"><div style="flex:1"><h3>Weather in ' + esc(g.name) + (g.country ? ', ' + esc(g.country) : '') + '</h3>' +
            '<div class="sw-now"><span class="sw-big-emoji">' + now[1] + '</span><span class="sw-temp">' + Math.round(c.temperature_2m) + '°C</span><span>' + esc(now[0]) +
            '<br><small>Wind ' + Math.round(c.wind_speed_10m) + ' km/h · Humidity ' + c.relative_humidity_2m + '%</small></span></div>' +
            '<div class="sw-days">' + days + '</div><p class="sw-src">Weather from Open-Meteo</p></div></div>';
        });
    });
  }

  function defineBox(word) {
    return getJson('https://api.dictionaryapi.dev/api/v2/entries/en/' + encodeURIComponent(word)).then(function (d) {
      var e = d && d[0]; if (!e) return '';
      var phon = e.phonetic || ((e.phonetics || []).filter(function (p) { return p.text; })[0] || {}).text || '';
      var audio = ((e.phonetics || []).filter(function (p) { return p.audio; })[0] || {}).audio;
      var parts = (e.meanings || []).slice(0, 3).map(function (m) {
        return '<p><i>' + esc(m.partOfSpeech) + '</i></p><ol>' + m.definitions.slice(0, 2).map(function (x) {
          return '<li>' + esc(x.definition) + (x.example ? '<br><small>“' + esc(x.example) + '”</small>' : '') + '</li>';
        }).join('') + '</ol>';
      }).join('');
      return '<div class="sw-card"><div><h3>' + esc(e.word) + ' <small class="sw-phon">' + esc(phon) + '</small>' +
        (audio ? ' <button type="button" class="sw-say" data-audio="' + esc(audio) + '" aria-label="Hear it">🔊</button>' : '') + '</h3>' + parts +
        '<p class="sw-src">Dictionary from Free Dictionary API (Wiktionary)</p></div></div>';
    }).catch(function () { return ''; });
  }

  function booksBox(q) {
    return getJson('https://openlibrary.org/search.json?limit=5&fields=key,title,author_name,first_publish_year,cover_i&q=' + encodeURIComponent(q)).then(function (d) {
      var docs = (d.docs || []).filter(function (b) { return b.title; }).slice(0, 5);
      if (!docs.length) return '';
      return '<div class="sw-card sw-books-card"><div style="flex:1"><h3>Books</h3><div class="sw-books">' + docs.map(function (b) {
        var cover = b.cover_i ? '<img src="https://covers.openlibrary.org/b/id/' + b.cover_i + '-M.jpg" alt="" loading="lazy">' : '<span class="sw-nocover">📖</span>';
        return '<a href="https://openlibrary.org' + esc(b.key) + '" target="_blank" rel="noopener">' + cover + '<b>' + esc(b.title) + '</b><small>' +
          esc((b.author_name || []).slice(0, 2).join(', ')) + (b.first_publish_year ? ' · ' + b.first_publish_year : '') + '</small></a>';
      }).join('') + '</div><p class="sw-src">Books from Open Library</p></div></div>';
    }).catch(function () { return ''; });
  }

  function mapBox(place) {
    return getJson('https://nominatim.openstreetmap.org/search?format=jsonv2&limit=1&accept-language=' + lang() + '&q=' + encodeURIComponent(place)).then(function (d) {
      var p = d && d[0]; if (!p) return '';
      var b = p.boundingbox.map(Number), lat = +p.lat, lon = +p.lon;
      if (b[1] - b[0] < 0.004) { b[0] = lat - 0.005; b[1] = lat + 0.005; b[2] = lon - 0.008; b[3] = lon + 0.008; }
      var bbox = [b[2], b[0], b[3], b[1]].join(',');
      return '<div class="sw-card sw-map"><div style="flex:1"><h3>' + esc(p.display_name.split(',').slice(0, 2).join(',')) + '</h3><p>' + esc(p.display_name) + '</p>' +
        '<iframe title="Map" loading="lazy" src="https://www.openstreetmap.org/export/embed.html?layer=mapnik&bbox=' + bbox + '&marker=' + lat + ',' + lon + '"></iframe>' +
        '<p><a href="https://www.openstreetmap.org/?mlat=' + lat + '&mlon=' + lon + '#map=13/' + lat + '/' + lon + '" target="_blank" rel="noopener">Open the big map</a></p>' +
        '<p class="sw-src">Map © OpenStreetMap contributors</p></div></div>';
    }).catch(function () { return ''; });
  }

  // A small, safe calculator: numbers, + - * / ^ % and brackets only.
  function calc(q) {
    var s = q.replace(/×/g, '*').replace(/÷/g, '/').replace(/,/g, '.').replace(/\s+/g, '');
    if (!/^[\d.+\-*/^%()]+$/.test(s) || !/\d[+\-*/^%]/.test(s)) return null;
    var pos = 0;
    function num() {
      if (s[pos] === '(') { pos++; var v = add(); if (s[pos] !== ')') throw 0; pos++; return v; }
      if (s[pos] === '-') { pos++; return -num(); }
      var m = /^\d*\.?\d+/.exec(s.slice(pos)); if (!m) throw 0; pos += m[0].length;
      var n = parseFloat(m[0]); if (s[pos] === '%') { pos++; n /= 100; } return n;
    }
    function pow() { var v = num(); if (s[pos] === '^') { pos++; return Math.pow(v, pow()); } return v; }
    function mul() { var v = pow(); while (s[pos] === '*' || s[pos] === '/') { var o = s[pos++], r = pow(); v = o === '*' ? v * r : v / r; } return v; }
    function add() { var v = mul(); while (s[pos] === '+' || s[pos] === '-') { var o = s[pos++], r = mul(); v = o === '+' ? v + r : v - r; } return v; }
    try { var v = add(); if (pos !== s.length || !isFinite(v)) return null; return Math.round(v * 1e10) / 1e10; } catch (e) { return null; }
  }

  function answer(q) {
    var t = q.trim(), m, c = calc(t);
    if (c !== null) return Promise.resolve('<div class="sw-card"><div><p class="sw-calc-q">' + esc(t) + ' =</p><p class="sw-calc">' + esc(c.toLocaleString(undefined, { maximumFractionDigits: 10 })) + '</p></div></div>');
    if ((m = /^(?:weather|cuaca|forecast)(?:\s+(?:in|at|for|di))?\s*(.*)$/i.exec(t)) || (m = /^(.+?)\s+(?:weather|forecast|cuaca)$/i.exec(t))) return weatherBox(m[1].trim());
    if ((m = /^(?:define|definition of|meaning of|what does)\s+([a-z' -]+?)(?:\s+mean)?\??$/i.exec(t)) || (m = /^([a-z'-]+)\s+(?:meaning|definition)$/i.exec(t))) return defineBox(m[1].trim());
    if ((m = /^(?:map of|where is|directions to|peta)\s+(.+?)\??$/i.exec(t)) || (m = /^(.+?)\s+(?:map|peta)$/i.exec(t))) return mapBox(m[1].trim());
    if ((m = /^(?:books? (?:by|about|on)|novels? by)\s+(.+)$/i.exec(t)) || (m = /^(.+?)\s+(?:books?|novels?)$/i.exec(t))) return booksBox(m[1].trim());
    return null;
  }

  // ------------------------------------------------------------ results page
  function webResults(q, page) {
    return server().then(function (base) {
      if (!base) throw new Error('no server');
      return getJson(base + '/swiss/search?q=' + encodeURIComponent(q) + '&page=' + page);
    });
  }

  function snippetHtml(s) {
    return esc(s).replace(/\u0001/g, '<b>').replace(/\u0002/g, '</b>');
  }

  function renderWeb(q, page) {
    var ul = $('sw-webres'), more = $('sw-more');
    webResults(q, page).then(function (d) {
      var items = (d.results || []).map(function (r) {
        return '<li><a href="' + esc(r.url) + '" target="_blank" rel="noopener">' + esc(r.title || hostOf(r.url)) + '</a><span class="sw-url">' + esc(r.url.replace(/^https?:\/\//, '').slice(0, 90)) +
          '</span><p>' + (r.snip ? snippetHtml(r.snip) : esc(r.description)) + '</p></li>';
      }).join('');
      if (!page) ul.innerHTML = items || '<li class="sw-wait">Swiss hasn’t read a page about this yet. SwissBot reads more websites every day.</li>';
      else ul.insertAdjacentHTML('beforeend', items);
      more.hidden = !d.more;
      more.onclick = function () { more.hidden = true; renderWeb(q, page + 1); };
    }).catch(function () {
      ul.innerHTML = '<li class="sw-wait">Swiss’s web index is warming up. Check back soon!</li>';
    });
  }

  function renderWiki(q) {
    var l = lang(), base = 'https://' + l + '.wikipedia.org', ul = $('sw-wiki');
    getJson(base + '/w/api.php?action=query&list=search&format=json&origin=*&srlimit=4&srsearch=' + encodeURIComponent(q))
      .then(function (d) {
        var hits = (d.query && d.query.search) || [];
        if (!hits.length) { ul.innerHTML = '<li class="sw-wait">No Wikipedia articles found.</li>'; return; }
        ul.innerHTML = hits.map(function (h) {
          var url = base + '/wiki/' + encodeURIComponent(h.title.replace(/ /g, '_'));
          return '<li><a href="' + url + '" target="_blank" rel="noopener">' + esc(h.title) + '</a><span class="sw-url">' + l + '.wikipedia.org</span><p>' + esc(strip(h.snippet)) + '…</p></li>';
        }).join('');
        if ($('sw-answer').innerHTML) return;
        return getJson(base + '/api/rest_v1/page/summary/' + encodeURIComponent(hits[0].title.replace(/ /g, '_'))).then(function (s) {
          if (!s.extract || s.type === 'disambiguation' || $('sw-answer').innerHTML) return;
          var img = s.thumbnail ? '<img src="' + esc(s.thumbnail.source) + '" alt="">' : '';
          $('sw-answer').innerHTML = '<div class="sw-card">' + img + '<div><h3>' + esc(s.title) + '</h3><p>' + esc(s.extract) + '</p><a href="' + esc(s.content_urls.desktop.page) + '" target="_blank" rel="noopener">Read more on Wikipedia</a></div></div>';
        });
      })
      .catch(function () { ul.innerHTML = '<li class="sw-wait">Couldn’t reach Wikipedia. Check your internet and try again.</li>'; });
  }

  function suggestForm() {
    return '<details class="sw-suggest"><summary>Know a good website Swiss should read?</summary>' +
      '<form id="sw-sug"><input type="text" name="url" placeholder="example.com" aria-label="Website address" required> <button class="btn" type="submit">Suggest</button></form><p id="sw-sug-msg" class="sw-wait"></p>' +
      '<p class="sw-src">SwissBot only reads websites the owner has checked, so Swiss stays safe for everyone. <a href="swiss-bot.html">About SwissBot</a></p></details>';
  }

  function wireSuggest() {
    var f = $('sw-sug'); if (!f) return;
    f.addEventListener('submit', function (e) {
      e.preventDefault();
      var msg = $('sw-sug-msg'); msg.textContent = 'Sending…';
      server().then(function (base) {
        return fetch(base + '/swiss/suggest', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ url: f.url.value }) });
      }).then(function (r) { return r.json(); })
        .then(function (d) { msg.textContent = d.message || d.error || 'Done.'; if (d.ok) f.reset(); })
        .catch(function () { msg.textContent = 'Couldn’t send that. Try again later.'; });
    });
  }

  function results(el, q) {
    if (!q) { el.innerHTML = ''; return; }
    var site = searchSite(q), html = '<div id="sw-answer"></div>';
    if (site.length) {
      html += '<h2>On Stick Hubs</h2><ol class="sw-list">' + site.map(function (p) {
        return '<li><a href="' + p[1] + '">' + esc(p[0]) + '</a><span class="sw-url">stick-hubs.github.io/' + p[1] + '</span><p>' + esc(p[2]) + '</p></li>';
      }).join('') + '</ol>';
    }
    html += '<h2>From the web</h2><ol class="sw-list" id="sw-webres"><li class="sw-wait">Searching…</li></ol><button type="button" class="btn sw-morebtn" id="sw-more" hidden>More results</button>' +
      '<h2>From Wikipedia</h2><ol class="sw-list" id="sw-wiki"><li class="sw-wait">Searching…</li></ol>' + suggestForm();
    if (calc(q.trim()) !== null) html = '<div id="sw-answer"></div>';
    el.innerHTML = html;
    var a = answer(q);
    if (a) a.then(function (h) { if (h) $('sw-answer').innerHTML = h; }).catch(function () {});
    if ($('sw-webres')) { renderWeb(q, 0); renderWiki(q); wireSuggest(); }
    el.addEventListener('click', function (e) {
      var b = e.target.closest('.sw-say'); if (b) new Audio(b.getAttribute('data-audio')).play().catch(function () {});
    });
  }

  function stats(el) {
    server().then(function (base) { return base && getJson(base + '/swiss/stats'); }).then(function (s) {
      if (s && s.pages) el.textContent = 'Swiss has read ' + s.pages.toLocaleString() + ' pages from ' + s.sites.toLocaleString() + ' websites so far, and reads more every day.';
    }).catch(function () {});
  }

  window.Swiss = { box: box, results: results, stats: stats, server: server, calc: calc };
})();
