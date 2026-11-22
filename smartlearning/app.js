// SmartLearning: a stickman quiz for up to 32 players. Made for Stick Hubs.
(function () {
  'use strict';
  var Q = window.SL_QUESTIONS;
  var Net = window.SLNet;
  var MAX_PLAYERS = 32;
  var LOBBY_PROJECT = 'stick-hubs-smartlearning-servers';
  var ROOM_PREFIX = 'stick-hubs-smartlearning-room-';
  var COLORS = ['#2f74d0', '#d9443a', '#3aa04a', '#e08a19', '#8a4fd0', '#d94f9a', '#1a9c9c', '#333333'];
  var LETTERS = ['A', 'B', 'C', 'D'];
  var REVEAL_WAIT = 9;

  var $win = document.getElementById('content');
  var $title = document.getElementById('wintitle');
  var app = {screen: 'home', host: null, player: null, finder: null};

  // ---------- helpers ----------
  function esc (s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return {'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[c];
    });
  }
  var BAD = /\b(fuck|shit|bitch|cunt|dick|pussy|nigg|fag|slut|whore|bastard|asshole|kontol|anjing|bangsat|memek)\w*/i;
  function cleanName (s) {
    s = String(s || '').replace(/[<>\u0000-\u001f]/g, '').replace(/\s+/g, ' ').trim().slice(0, 16);
    if (!s || BAD.test(s)) s = 'Player ' + (10 + Math.floor(Math.random() * 89));
    return s;
  }
  function rid () { return Math.floor(10000 + (Math.random() * 89999)); }
  function shuffle (a) {
    a = a.slice();
    for (var i = a.length - 1; i > 0; i--) {
      var j = Math.floor(Math.random() * (i + 1));
      var t = a[i]; a[i] = a[j]; a[j] = t;
    }
    return a;
  }
  function stick (color, size, pose) {
    size = size || 48;
    var arms = pose === 'win' ? 'M24 20 L12 8 M24 20 L36 8' : pose === 'sad' ? 'M24 21 L16 32 M24 21 L32 32' : 'M24 21 L13 27 M24 21 L35 27';
    return '<svg class="stick" width="' + size + '" height="' + size + '" viewBox="0 0 48 48" aria-hidden="true">' +
      '<circle cx="24" cy="11" r="7" fill="' + color + '"/>' +
      '<path d="M24 18 V33 ' + arms + ' M24 33 L16 45 M24 33 L32 45" stroke="' + color + '" stroke-width="4.2" stroke-linecap="round" fill="none"/>' +
      '<circle cx="26.5" cy="10" r="1.4" fill="#fff"/></svg>';
  }
  function saved (k, d) { try { var v = localStorage.getItem('smartlearning-' + k); return v === null ? d : v; } catch (e) { return d; } }
  function save (k, v) { try { localStorage.setItem('smartlearning-' + k, v); } catch (e) {} }
  function me () { return {name: cleanName(saved('name', '')), color: saved('color', COLORS[0])}; }

  // ---------- sound (made with Web Audio, no files) ----------
  var audio = null;
  function tone (freqs, len, type, vol) {
    try {
      audio = audio || new (window.AudioContext || window.webkitAudioContext)();
      var t0 = audio.currentTime;
      freqs.forEach(function (f, i) {
        var o = audio.createOscillator(); var g = audio.createGain();
        o.type = type || 'sine'; o.frequency.value = f;
        g.gain.setValueAtTime(0, t0 + (i * len)); g.gain.linearRampToValueAtTime(vol || 0.12, t0 + (i * len) + 0.02);
        g.gain.exponentialRampToValueAtTime(0.001, t0 + ((i + 1) * len) + 0.25);
        o.connect(g); g.connect(audio.destination); o.start(t0 + (i * len)); o.stop(t0 + ((i + 1) * len) + 0.3);
      });
    } catch (e) {}
  }
  var sfx = {
    start: function () { tone([523, 659, 784, 1047], 0.12, 'sine', 0.1); },
    good: function () { tone([659, 988], 0.11, 'triangle', 0.14); },
    bad: function () { tone([330, 247], 0.16, 'sawtooth', 0.05); },
    click: function () { tone([880], 0.03, 'sine', 0.05); },
    join: function () { tone([784, 1175], 0.07, 'sine', 0.06); },
    end: function () { tone([523, 659, 784, 659, 784, 1047], 0.13, 'triangle', 0.1); }
  };

  function show (title, html) {
    $title.textContent = title ? 'SmartLearning - ' + title : 'SmartLearning';
    $win.innerHTML = html;
    $win.scrollTop = 0;
  }
  function flash (text) {
    var el = document.getElementById('toast');
    el.textContent = text; el.hidden = false;
    clearTimeout(flash.t); flash.t = setTimeout(function () { el.hidden = true; }, 3200);
  }

  // ---------- Host: runs the game. Everyone else just shows what the host sends. ----------
  function Host (opts) {
    var self = this;
    this.opts = opts; // {room, cat, count, time, public, plays, local}
    this.hid = rid();
    this.code = opts.local ? '' : String(100000 + Math.floor(Math.random() * 900000));
    this.players = new Map();
    this.phase = 'lobby';
    this.qi = -1;
    this.questions = this.pickQuestions();
    this.answers = new Map();
    this.counts = [0, 0, 0, 0];
    this.status = opts.local ? 'open' : 'connecting';
    if (opts.plays) {
      var m = me();
      this.selfId = rid();
      this.players.set(this.selfId, {pid: this.selfId, name: m.name, color: m.color, score: 0, streak: 0, seen: Infinity, isHost: true});
    }
    if (opts.local) {
      this.room = new Net.LocalChannel();
    } else {
      this.room = new Net.Channel(ROOM_PREFIX + this.code, function (m) { self.onMessage(m); }, function (s) {
        self.status = s;
        if (s === 'open') self.broadcastLobby();
        self.render();
      });
      if (opts.public) {
        this.lobby = new Net.Channel(LOBBY_PROJECT, function () {}, function () {});
        this.adTimer = setInterval(function () { self.advertise(); }, 3000);
        setTimeout(function () { self.advertise(); }, 600);
      }
      this.beat = setInterval(function () { self.heartbeat(); }, 2000);
    }
  }

  Host.prototype.pickQuestions = function () {
    var cat = this.opts.cat;
    if (/^my:/.test(cat)) {
      var quiz = this.quiz || (this.quiz = getQuiz(cat.slice(3)));
      if (!quiz) return [];
      // a teacher's quiz keeps its order; only the answers get mixed up
      return quiz.questions.slice(0, this.opts.count).map(function (r) {
        var choices = shuffle(r.slice(1));
        return {text: r[0], ch: choices, ok: choices.indexOf(r[1]), cat: quiz.title};
      });
    }
    var pool = [];
    var cats = cat === 'mixed' ? Object.keys(Q) : [cat];
    cats.forEach(function (c) { Q[c].q.forEach(function (q) { pool.push({c: c, q: q}); }); });
    return shuffle(pool).slice(0, Math.min(this.opts.count, pool.length)).map(function (it) {
      var choices = shuffle(it.q.slice(1));
      return {text: it.q[0], ch: choices, ok: choices.indexOf(it.q[1]), cat: Q[it.c].name};
    });
  };

  Host.prototype.catName = function () {
    if (/^my:/.test(this.opts.cat)) return this.quiz ? this.quiz.title : 'My quiz';
    return this.opts.cat === 'mixed' ? 'Mixed' : Q[this.opts.cat].name;
  };
  Host.prototype.list = function () {
    return Array.from(this.players.values());
  };
  Host.prototype.online = function () {
    var now = Date.now();
    return this.list().filter(function (p) { return p.seen === Infinity || now - p.seen < 14000; });
  };

  Host.prototype.advertise = function () {
    if (!this.lobby || this.phase === 'closed') return;
    this.lobby.send({k: 'ad', code: this.code, room: this.opts.room, host: me().name, n: this.online().length,
      max: MAX_PLAYERS, cat: this.catName(), st: this.phase === 'lobby' ? 'lobby' : 'playing'});
  };

  Host.prototype.lobbyPacket = function () {
    return {k: 'lobby', hid: this.hid, room: this.opts.room, host: me().name, cat: this.catName(), n: this.questions.length,
      max: MAX_PLAYERS, pl: this.online().map(function (p) { return [p.pid, p.name, p.color]; })};
  };
  Host.prototype.broadcastLobby = function () { this.room.send(this.lobbyPacket()); };

  Host.prototype.heartbeat = function () {
    var self = this;
    var now = Date.now();
    var changed = false;
    if (this.phase === 'lobby') {
      this.list().forEach(function (p) {
        if (p.seen !== Infinity && now - p.seen > 14000) { self.players.delete(p.pid); changed = true; }
      });
      this.broadcastLobby();
      if (changed) this.render();
    } else if (this.phase === 'question') {
      this.room.send({k: 'tick', hid: this.hid, i: this.qi, left: this.left(), got: Array.from(this.answers.keys())});
    }
  };

  Host.prototype.onMessage = function (m) {
    var self = this;
    if (!m || !m.pid) return;
    var p = this.players.get(m.pid);
    if (m.k === 'join' || m.k === 'here') {
      if (!p) {
        if (m.k === 'here') return;
        if (this.online().length >= MAX_PLAYERS) {
          this.room.send({k: 'no', hid: this.hid, pid: m.pid, why: 'This room is full (' + MAX_PLAYERS + ' players).'});
          return;
        }
        p = {pid: m.pid, name: cleanName(m.name), color: COLORS.indexOf(m.color) >= 0 ? m.color : COLORS[0], score: 0, streak: 0, seen: Date.now()};
        this.players.set(m.pid, p);
        sfx.join();
        if (this.phase === 'lobby') this.broadcastLobby();
        else this.room.send({k: 'welcome', hid: this.hid, pid: m.pid, room: this.opts.room});
        this.render();
        if (this.phase === 'question') this.sendQuestion(m.pid);
      } else {
        if (p.seen !== Infinity) p.seen = Date.now();
        if (m.k === 'join' && this.phase === 'lobby') this.broadcastLobby();
      }
    } else if (m.k === 'ans' && p) {
      if (p.seen !== Infinity) p.seen = Date.now();
      if (this.phase === 'question' && m.i === this.qi && !this.answers.has(m.pid) && m.a >= 0 && m.a < 4) {
        this.answers.set(m.pid, {a: m.a, ms: Math.max(0, Date.now() - this.qStart)});
        this.counts[m.a]++;
        this.render();
        if (this.answers.size >= this.online().length) setTimeout(function () { self.reveal(); }, 400);
      }
    } else if (m.k === 'bye' && p) {
      p.seen = 0;
      if (this.phase === 'lobby') { this.players.delete(m.pid); this.broadcastLobby(); }
      this.render();
    }
  };

  Host.prototype.kick = function (pid) {
    this.players.delete(pid);
    this.room.send({k: 'kick', hid: this.hid, pid: pid});
    this.broadcastLobby();
    this.render();
  };

  Host.prototype.start = function () {
    if (this.online().length < 1) { flash('Wait for at least one player to join.'); return; }
    sfx.start();
    this.next();
  };

  Host.prototype.left = function () {
    return Math.max(0, Math.ceil(((this.qStart + (this.opts.time * 1000)) - Date.now()) / 1000));
  };

  Host.prototype.sendQuestion = function (onlyFor) {
    var q = this.questions[this.qi];
    this.room.send({k: 'q', hid: this.hid, i: this.qi, n: this.questions.length, text: q.text, ch: q.ch, time: this.opts.time,
      left: this.left(), cat: q.cat, to: onlyFor || 0});
  };

  Host.prototype.next = function () {
    var self = this;
    clearTimeout(this.autoNext);
    this.qi++;
    if (this.qi >= this.questions.length) { this.finish(); return; }
    this.phase = 'question';
    this.answers = new Map();
    this.counts = [0, 0, 0, 0];
    this.qStart = Date.now();
    this.sendQuestion();
    clearInterval(this.clock);
    this.clock = setInterval(function () {
      if (self.phase !== 'question') { clearInterval(self.clock); return; }
      if (self.left() <= 0) self.reveal();
      else self.renderTimer();
    }, 250);
    this.render();
  };

  Host.prototype.answerSelf = function (a) {
    if (this.phase !== 'question' || !this.selfId || this.answers.has(this.selfId)) return;
    this.onMessage({k: 'ans', pid: this.selfId, i: this.qi, a: a});
  };

  Host.prototype.reveal = function () {
    var self = this;
    if (this.phase !== 'question') return;
    clearInterval(this.clock);
    this.phase = 'reveal';
    var q = this.questions[this.qi];
    var res = {};
    var time = this.opts.time * 1000;
    this.list().forEach(function (p) {
      var a = self.answers.get(p.pid);
      var ok = !!a && a.a === q.ok;
      var gain = 0;
      if (ok) {
        p.streak++;
        gain = 500 + Math.round(500 * Math.max(0, 1 - (a.ms / time))) + (Math.min(3, p.streak - 1) * 100);
        p.score += gain;
      } else {
        p.streak = 0;
      }
      p.last = {ok: ok, gain: gain, answered: !!a};
    });
    var board = this.board();
    board.forEach(function (p, i) {
      p.rank = i + 1;
      res[p.pid] = [p.last.ok ? 1 : 0, p.last.gain, p.score, p.rank, p.streak, p.last.answered ? 1 : 0];
    });
    this.room.send({k: 'rev', hid: this.hid, i: this.qi, ok: q.ok, counts: this.counts, res: res,
      top: board.slice(0, 5).map(function (p) { return [p.name, p.color, p.score]; }), last: this.qi >= this.questions.length - 1});
    if (this.selfId) (this.players.get(this.selfId).last.ok ? sfx.good : sfx.bad)();
    this.render();
    this.autoNext = setTimeout(function () { if (self.phase === 'reveal' && self.opts.auto) self.next(); }, REVEAL_WAIT * 1000);
  };

  Host.prototype.board = function () {
    return this.list().slice().sort(function (a, b) { return b.score - a.score; });
  };

  Host.prototype.finish = function () {
    this.phase = 'end';
    var board = this.board();
    this.room.send({k: 'end', hid: this.hid, board: board.slice(0, 32).map(function (p) { return [p.pid, p.name, p.color, p.score]; })});
    sfx.end();
    this.advertise();
    this.render();
  };

  Host.prototype.again = function () {
    this.questions = this.pickQuestions();
    if (this.opts.local) { this.qi = -1; this.list().forEach(function (p) { p.score = 0; p.streak = 0; }); this.next(); return; }
    this.qi = -1;
    this.phase = 'lobby';
    this.list().forEach(function (p) { p.score = 0; p.streak = 0; });
    this.broadcastLobby();
    this.advertise();
    this.render();
  };

  Host.prototype.close = function () {
    this.phase = 'closed';
    clearInterval(this.beat); clearInterval(this.adTimer); clearInterval(this.clock); clearTimeout(this.autoNext);
    this.room.close({k: 'close', hid: this.hid});
    if (this.lobby) this.lobby.close({k: 'gone', code: this.code});
  };

  Host.prototype.renderTimer = function () {
    var el = document.getElementById('timer');
    if (!el) return;
    var left = this.left();
    el.querySelector('b').textContent = left;
    el.querySelector('i').style.width = (100 * left / this.opts.time) + '%';
  };

  Host.prototype.render = function () {
    if (app.host !== this) return;
    var self = this;
    var o = this.opts;
    if (this.phase === 'lobby') {
      var players = this.online();
      var url = location.origin + location.pathname + '?join=' + this.code;
      var list = players.map(function (p) {
        return '<li>' + stick(p.color, 36) + '<span>' + esc(p.name) + (p.isHost ? ' <em>(host)</em>' : '') + '</span>' +
          (p.isHost ? '' : '<button class="x" data-act="kick" data-pid="' + p.pid + '" title="Remove ' + esc(p.name) + '">&times;</button>') + '</li>';
      }).join('');
      var join = o.local ? '' : '<div class="joinbox"><div class="qr" id="qr"></div><div>' +
        '<div class="label">Room code</div><div class="code">' + this.code.slice(0, 3) + ' ' + this.code.slice(3) + '</div>' +
        '<div class="label">Scan the QR code, type the code, or find <b>' + esc(o.room) + '</b> in <b>Find a server</b>' + (o.public ? '' : ' (this room is private, so it isn\'t listed)') + '.</div>' +
        '<div class="url">' + esc(url) + '</div>' +
        '<div class="status ' + this.status + '">' + (this.status === 'open' ? 'Online' : this.status === 'connecting' ? 'Connecting...' : 'Reconnecting...') + '</div></div></div>';
      show(o.room, '<div class="pane"><h2>' + esc(o.room) + '</h2><p class="sub">' + esc(this.catName()) + ' &middot; ' + this.questions.length + ' questions &middot; ' + o.time + ' seconds each</p>' + join +
        '<div class="grouphead">Players <b>' + players.length + '/' + MAX_PLAYERS + '</b></div>' +
        '<ul class="players">' + (list || '<li class="empty">Waiting for players to join...</li>') + '</ul>' +
        '<div class="row"><button class="aero" data-act="quit">Close room</button><span class="grow"></span><button class="aero primary big" data-act="start"' + (players.length ? '' : ' disabled') + '>Start game &#9654;</button></div></div>');
      if (!o.local) {
        try {
          var qr = qrcode(0, 'M'); qr.addData(url); qr.make();
          document.getElementById('qr').innerHTML = qr.createSvgTag({cellSize: 4, margin: 2, scalable: true});
        } catch (e) {}
      }
      return;
    }
    if (this.phase === 'question' || this.phase === 'reveal') {
      var q = this.questions[this.qi];
      var revealed = this.phase === 'reveal';
      var mine = this.selfId ? this.answers.get(this.selfId) : null;
      var total = Math.max(1, this.online().length);
      var btns = q.ch.map(function (c, i) {
        var cls = 'ans a' + i + (revealed ? (i === q.ok ? ' right' : ' dim') : '') + (mine && mine.a === i ? ' picked' : '');
        var count = revealed || !self.selfId ? '<span class="count">' + self.counts[i] + '</span>' : '';
        return '<button class="' + cls + '" data-act="ans" data-a="' + i + '"' + ((!self.selfId || mine || revealed) ? ' disabled' : '') + '><span class="l">' + LETTERS[i] + '</span><span class="t">' + esc(c) + '</span>' + count + '</button>';
      }).join('');
      var top = '';
      var footer;
      if (revealed) {
        top = '<div class="grouphead">Top players</div><ol class="board">' + this.board().slice(0, 5).map(function (p) {
          return '<li>' + stick(p.color, 30) + '<span>' + esc(p.name) + '</span><b>' + p.score + '</b>' + (p.last && p.last.gain ? '<em>+' + p.last.gain + '</em>' : '') + '</li>';
        }).join('') + '</ol>';
        var mineRes = this.selfId ? this.players.get(this.selfId).last : null;
        footer = '<div class="row">' + (mineRes ? '<span class="verdict ' + (mineRes.ok ? 'good' : 'bad') + '">' + (mineRes.ok ? 'Correct! +' + mineRes.gain : mineRes.answered ? 'Wrong answer' : 'Too slow!') + '</span>' : '') +
          '<span class="grow"></span><button class="aero primary big" data-act="next">' + (this.qi >= this.questions.length - 1 ? 'See results &#9654;' : 'Next question &#9654;') + '</button></div>';
      } else {
        footer = '<div class="row"><span class="answered">' + this.answers.size + ' of ' + total + ' answered</span><span class="grow"></span><button class="aero" data-act="skip">Skip timer</button></div>';
      }
      show('Question ' + (this.qi + 1), '<div class="pane"><div class="qhead"><span>Question ' + (this.qi + 1) + ' of ' + this.questions.length + ' &middot; ' + esc(q.cat) + '</span>' +
        (o.local ? '' : '<span class="small">Code ' + this.code + '</span>') + '</div>' +
        '<h2 class="question">' + esc(q.text) + '</h2>' +
        (revealed ? '' : '<div class="timer" id="timer"><i style="width:' + (100 * this.left() / o.time) + '%"></i><b>' + this.left() + '</b></div>') +
        '<div class="answers">' + btns + '</div>' + top + footer + '</div>');
      return;
    }
    if (this.phase === 'end') {
      var b = this.board();
      show('Results', podium(b.map(function (p) { return [p.pid, p.name, p.color, p.score]; }), this.selfId) +
        '<div class="row pad"><button class="aero" data-act="quit">' + (o.local ? 'Back to menu' : 'Close room') + '</button><span class="grow"></span><button class="aero primary big" data-act="again">Play again</button></div>');
    }
  };

  function podium (board, myPid) {
    var top = board.slice(0, 3);
    var order = [1, 0, 2];
    var html = '<div class="pane"><h2 class="center">Final results</h2><div class="podium">';
    order.forEach(function (i) {
      var p = top[i];
      if (!p) return;
      html += '<div class="step s' + (i + 1) + '">' + stick(p[2], i === 0 ? 72 : 56, 'win') + '<div class="pname">' + esc(p[1]) + '</div><div class="pscore">' + p[3] + '</div><div class="block">' + (i + 1) + '</div></div>';
    });
    html += '</div><ol class="board full">' + board.map(function (p, i) {
      return '<li' + (p[0] === myPid ? ' class="me"' : '') + '><span class="rank">' + (i + 1) + '</span>' + stick(p[2], 26) + '<span>' + esc(p[1]) + '</span><b>' + p[3] + '</b></li>';
    }).join('') + '</ol></div>';
    return html;
  }

  // ---------- Player: joins someone else's room ----------
  function Player (code) {
    var self = this;
    var m = me();
    this.code = code;
    this.pid = rid();
    this.name = m.name;
    this.color = m.color;
    this.state = 'joining';
    this.hid = 0;
    this.q = null;
    this.answer = -1;
    this.lastHost = 0;
    this.channel = new Net.Channel(ROOM_PREFIX + code, function (msg) { self.onMessage(msg); }, function (s) {
      self.net = s;
      if (s === 'open') self.sendJoin();
    });
    this.joinTimer = setInterval(function () {
      if (self.state === 'joining') self.sendJoin();
      else self.channel.send({k: 'here', pid: self.pid});
      if (self.state !== 'joining' && Date.now() - self.lastHost > 15000 && self.state !== 'end') {
        self.state = 'lost'; self.render();
      }
    }, 3000);
    this.giveUp = setTimeout(function () {
      if (self.state === 'joining') { self.state = 'nohost'; self.render(); }
    }, 12000);
    this.render();
  }

  Player.prototype.sendJoin = function () {
    this.channel.send({k: 'join', pid: this.pid, name: this.name, color: this.color});
  };

  Player.prototype.onMessage = function (m) {
    var self = this;
    if (!m || !m.hid) return;
    if (this.hid && m.hid !== this.hid) return;
    if (m.t && Math.abs(Date.now() - m.t) > 600000) return; // old message left on the server
    if (m.pid && m.pid !== this.pid && (m.k === 'kick' || m.k === 'no' || m.k === 'welcome')) return;
    this.lastHost = Date.now();
    if (m.k === 'lobby') {
      var inRoom = (m.pl || []).some(function (p) { return p[0] === self.pid; });
      if (!inRoom) { if (this.state !== 'joining' && this.state !== 'nohost') this.sendJoin(); return; }
      this.hid = m.hid;
      if (this.state === 'joining' || this.state === 'nohost' || this.state === 'lost') sfx.join();
      if (this.state !== 'lobby' || JSON.stringify(m.pl) !== JSON.stringify(this.lobby && this.lobby.pl)) {
        this.state = 'lobby'; this.lobby = m; this.render();
      }
    } else if (m.k === 'welcome') {
      this.hid = m.hid; this.state = 'wait'; this.room = m.room; this.render();
    } else if (m.k === 'q') {
      if (m.to && m.to !== this.pid) return;
      if (!this.hid) { if (this.state === 'joining') return; this.hid = m.hid; }
      if (this.q && this.q.i === m.i && this.state === 'question') return;
      this.q = m; this.answer = -1; this.state = 'question';
      this.deadline = Date.now() + (m.left * 1000);
      this.render();
      clearInterval(this.clock);
      this.clock = setInterval(function () { self.tick(); }, 250);
    } else if (m.k === 'tick') {
      if (!this.q || this.q.i !== m.i) return;
      this.deadline = Date.now() + (m.left * 1000);
      if (this.answer >= 0 && (m.got || []).indexOf(this.pid) < 0) this.sendAnswer(); // the host missed it: send again
    } else if (m.k === 'rev') {
      if (!this.q || this.q.i !== m.i) return;
      clearInterval(this.clock);
      this.rev = m; this.state = 'reveal';
      var r = m.res[this.pid];
      if (r) (r[0] ? sfx.good : sfx.bad)();
      this.render();
    } else if (m.k === 'end') {
      clearInterval(this.clock);
      this.board = m.board; this.state = 'end'; sfx.end(); this.render();
    } else if (m.k === 'kick' && m.pid === this.pid) {
      this.leave(); this.state = 'kicked'; this.render();
    } else if (m.k === 'no' && m.pid === this.pid) {
      this.leave(); this.state = 'rejected'; this.why = m.why; this.render();
    } else if (m.k === 'close') {
      this.leave(); this.state = 'closed'; this.render();
    }
  };

  Player.prototype.tick = function () {
    var el = document.getElementById('timer');
    if (!el || !this.q) return;
    var left = Math.max(0, Math.ceil((this.deadline - Date.now()) / 1000));
    el.querySelector('b').textContent = left;
    el.querySelector('i').style.width = (100 * left / this.q.time) + '%';
  };

  Player.prototype.pick = function (a) {
    if (this.state !== 'question' || this.answer >= 0) return;
    this.answer = a;
    sfx.click();
    this.sendAnswer();
    this.render();
  };
  Player.prototype.sendAnswer = function () {
    this.channel.send({k: 'ans', pid: this.pid, i: this.q.i, a: this.answer});
  };

  Player.prototype.leave = function () {
    clearInterval(this.joinTimer); clearInterval(this.clock); clearTimeout(this.giveUp);
    if (this.channel) this.channel.close({k: 'bye', pid: this.pid});
    this.channel = null;
  };

  Player.prototype.render = function () {
    if (app.player !== this) return;
    var s = this.state;
    var back = '<div class="row"><button class="aero" data-act="home">Back to menu</button></div>';
    if (s === 'joining') {
      show('Joining', '<div class="pane center"><div class="spinner"></div><h2>Joining room ' + esc(this.code) + '...</h2><p class="sub">Looking for the host.</p><div class="row"><button class="aero" data-act="home">Cancel</button></div></div>');
    } else if (s === 'nohost') {
      show('Room not found', '<div class="pane center"><h2>Couldn\'t find room ' + esc(this.code) + '</h2><p class="sub">Check the code, and make sure the host still has the room open. Still trying...</p>' + back + '</div>');
    } else if (s === 'lobby' || s === 'wait') {
      var l = this.lobby || {pl: [], room: this.room || 'Room'};
      var pl = (l.pl || []).map(function (p) { return '<li>' + stick(p[2], 36) + '<span>' + esc(p[1]) + '</span></li>'; }).join('');
      show(l.room, '<div class="pane"><div class="center">' + stick(this.color, 84, 'win') + '<h2>You\'re in, ' + esc(this.name) + '!</h2><p class="sub">' +
        (s === 'wait' ? 'The game already started. You\'ll join from the next question.' : 'Waiting for <b>' + esc(l.host || 'the host') + '</b> to start' + (l.cat ? ' &middot; ' + esc(l.cat) + ' &middot; ' + l.n + ' questions' : '') + '.') + '</p></div>' +
        (pl ? '<div class="grouphead">Players <b>' + (l.pl || []).length + '/' + (l.max || MAX_PLAYERS) + '</b></div><ul class="players">' + pl + '</ul>' : '') +
        '<div class="row"><button class="aero" data-act="home">Leave</button></div></div>');
    } else if (s === 'question' || s === 'reveal') {
      var q = this.q;
      var rev = s === 'reveal' ? this.rev : null;
      var self = this;
      var btns = q.ch.map(function (c, i) {
        var cls = 'ans a' + i + (rev ? (i === rev.ok ? ' right' : ' dim') : '') + (self.answer === i ? ' picked' : '') + (!rev && self.answer >= 0 && self.answer !== i ? ' dim' : '');
        return '<button class="' + cls + '" data-act="pans" data-a="' + i + '"' + (rev || self.answer >= 0 ? ' disabled' : '') + '><span class="l">' + LETTERS[i] + '</span><span class="t">' + esc(c) + '</span>' + (rev ? '<span class="count">' + rev.counts[i] + '</span>' : '') + '</button>';
      }).join('');
      var bottom = '';
      if (rev) {
        var r = rev.res[this.pid];
        if (r) {
          bottom = '<div class="result ' + (r[0] ? 'good' : 'bad') + '">' + stick(this.color, 56, r[0] ? 'win' : 'sad') + '<div><div class="big">' + (r[0] ? 'Correct! +' + r[1] : r[5] ? 'Wrong answer' : 'Too slow!') + '</div>' +
            '<div>Score <b>' + r[2] + '</b> &middot; You are <b>#' + r[3] + '</b>' + (r[4] > 1 ? ' &middot; ' + r[4] + ' in a row!' : '') + '</div></div></div>';
        }
        bottom += '<div class="grouphead">Top players</div><ol class="board">' + rev.top.map(function (p) { return '<li>' + stick(p[1], 30) + '<span>' + esc(p[0]) + '</span><b>' + p[2] + '</b></li>'; }).join('') + '</ol>' +
          '<p class="sub center">' + (rev.last ? 'Final results coming up...' : 'Next question coming up...') + '</p>';
      } else if (this.answer >= 0) {
        bottom = '<p class="sub center locked">Answer locked in! Waiting for everyone...</p>';
      }
      show('Question ' + (q.i + 1), '<div class="pane"><div class="qhead"><span>Question ' + (q.i + 1) + ' of ' + q.n + ' &middot; ' + esc(q.cat) + '</span></div>' +
        '<h2 class="question">' + esc(q.text) + '</h2>' +
        (rev ? '' : '<div class="timer" id="timer"><i style="width:' + (100 * Math.max(0, this.deadline - Date.now()) / (q.time * 1000)) + '%"></i><b>' + Math.max(0, Math.ceil((this.deadline - Date.now()) / 1000)) + '</b></div>') +
        '<div class="answers">' + btns + '</div>' + bottom + '</div>');
    } else if (s === 'end') {
      show('Results', podium(this.board, this.pid) + '<p class="sub center">The host can start another round.</p><div class="row pad"><button class="aero" data-act="home">Back to menu</button><span class="grow"></span><button class="aero primary" data-act="stay">Stay for next round</button></div>');
    } else if (s === 'kicked') {
      show('Removed', '<div class="pane center"><h2>The host removed you from the room.</h2>' + back + '</div>');
    } else if (s === 'rejected') {
      show('Can\'t join', '<div class="pane center"><h2>' + esc(this.why || 'Can\'t join this room.') + '</h2>' + back + '</div>');
    } else if (s === 'closed') {
      show('Room closed', '<div class="pane center"><h2>The host closed the room.</h2>' + back + '</div>');
    } else if (s === 'lost') {
      show('Connection lost', '<div class="pane center"><div class="spinner"></div><h2>Lost the host...</h2><p class="sub">Trying to reconnect. If the host left, go back to the menu.</p>' + back + '</div>');
    }
  };

  // ---------- Find a server ----------
  function Finder () {
    var self = this;
    this.rooms = new Map();
    this.status = 'connecting';
    this.channel = new Net.Channel(LOBBY_PROJECT, function (m) { self.onMessage(m); }, function (s) { self.status = s; self.render(); });
    this.timer = setInterval(function () { self.render(); }, 2000);
    this.render();
  }
  Finder.prototype.onMessage = function (m) {
    if (!m || !m.code) return;
    if (m.k === 'gone') { this.rooms.delete(m.code); this.render(); return; }
    if (m.k !== 'ad' || (m.t && Math.abs(Date.now() - m.t) > 20000)) return;
    var isNew = !this.rooms.has(m.code);
    m.seen = Date.now();
    this.rooms.set(m.code, m);
    if (isNew) this.render();
  };
  Finder.prototype.stop = function () { clearInterval(this.timer); this.channel.close(); };
  Finder.prototype.render = function () {
    if (app.finder !== this) return;
    var now = Date.now();
    var rooms = Array.from(this.rooms.values()).filter(function (r) { return now - r.seen < 10000; });
    rooms.sort(function (a, b) { return (a.st === 'lobby' ? 0 : 1) - (b.st === 'lobby' ? 0 : 1) || b.n - a.n; });
    var rows = rooms.map(function (r) {
      var full = r.n >= r.max;
      return '<tr><td><b>' + esc(r.room) + '</b><div class="small">by ' + esc(r.host) + '</div></td><td>' + esc(r.cat) + '</td><td>' + r.n + '/' + r.max + '</td><td>' +
        (r.st === 'lobby' ? '<span class="tag ok">Waiting</span>' : '<span class="tag">Playing</span>') + '</td><td><button class="aero primary" data-act="joincode" data-code="' + esc(r.code) + '"' + (full ? ' disabled' : '') + '>' + (full ? 'Full' : 'Join') + '</button></td></tr>';
    }).join('');
    show('Find a server', '<div class="pane"><h2>Find a server</h2><p class="sub">Public rooms show up here. Rooms that are playing let you join from the next question.</p>' +
      '<table class="servers"><thead><tr><th>Room</th><th>Topic</th><th>Players</th><th>Status</th><th></th></tr></thead><tbody>' +
      (rows || '<tr><td colspan="5" class="empty">' + (this.status === 'open' ? '<div class="spinner small"></div> Looking for rooms... No public rooms right now. Host one!' : 'Connecting to the server list...') + '</td></tr>') + '</tbody></table>' +
      '<div class="row"><button class="aero" data-act="home">Back</button><span class="grow"></span><button class="aero" data-act="code">Join with code</button><button class="aero primary" data-act="hostsetup">Host a game</button></div></div>');
  };


  // ---------- My quizzes: teachers make, save and share their own quizzes ----------
  var LIMITS = {questions: 50, title: 40, text: 200, answer: 80};
  function loadQuizzes () {
    try { var a = JSON.parse(localStorage.getItem('smartlearning-quizzes') || '[]'); return Array.isArray(a) ? a : []; } catch (e) { return []; }
  }
  function storeQuizzes (list) {
    try { localStorage.setItem('smartlearning-quizzes', JSON.stringify(list)); return true; } catch (e) { flash('Couldn\'t save: this browser\'s storage is full or turned off.'); return false; }
  }
  function getQuiz (id) { return loadQuizzes().filter(function (q) { return q.id === id; })[0]; }
  function cleanQuiz (q) {
    // makes any quiz (typed, imported or from a link) safe and the right shape
    if (!q || typeof q !== 'object') return null;
    var out = {id: typeof q.id === 'string' ? q.id.slice(0, 20) : 'q' + Date.now().toString(36), title: String(q.title || 'My quiz').slice(0, LIMITS.title),
      questions: [], updated: Date.now()};
    (Array.isArray(q.questions) ? q.questions : []).slice(0, LIMITS.questions).forEach(function (row) {
      if (!Array.isArray(row) || row.length < 5) return;
      var r = row.slice(0, 5).map(function (x, i) { return String(x == null ? '' : x).slice(0, i ? LIMITS.answer : LIMITS.text); });
      out.questions.push(r);
    });
    return out;
  }
  function quizProblems (q) {
    var bad = [];
    if (!q.title.trim()) bad.push('Give the quiz a title.');
    if (!q.questions.length) bad.push('Add at least one question.');
    q.questions.forEach(function (r, i) {
      if (!r[0].trim()) bad.push('Question ' + (i + 1) + ' has no question text.');
      if (r.slice(1).some(function (a) { return !a.trim(); })) bad.push('Question ' + (i + 1) + ' needs all 4 answers.');
      else if (new Set(r.slice(1).map(function (a) { return a.trim().toLowerCase(); })).size < 4) bad.push('Question ' + (i + 1) + ' has two answers that are the same.');
    });
    return bad;
  }
  function b64url (str) { return btoa(unescape(encodeURIComponent(str))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); }
  function unb64url (str) { str = str.replace(/-/g, '+').replace(/_/g, '/'); while (str.length % 4) str += '='; return decodeURIComponent(escape(atob(str))); }
  function shareLink (q) {
    return location.origin + location.pathname + '#quiz=' + b64url(JSON.stringify({title: q.title, questions: q.questions}));
  }

  function myQuizzes () {
    stopAll();
    var list = loadQuizzes().sort(function (a, b) { return b.updated - a.updated; });
    var rows = list.map(function (q) {
      return '<tr><td><b>' + esc(q.title) + '</b><div class="small">' + q.questions.length + ' question' + (q.questions.length === 1 ? '' : 's') + ' &middot; saved ' + new Date(q.updated).toLocaleDateString() + '</div></td>' +
        '<td class="acts"><button class="aero primary" data-act="qhost" data-id="' + q.id + '">Host</button><button class="aero" data-act="qplay" data-id="' + q.id + '">Practice</button>' +
        '<button class="aero" data-act="qedit" data-id="' + q.id + '">Edit</button><button class="aero" data-act="qshare" data-id="' + q.id + '">Share</button>' +
        '<button class="aero" data-act="qexport" data-id="' + q.id + '">Download</button><button class="aero" data-act="qdel" data-id="' + q.id + '">Delete</button></td></tr>';
    }).join('');
    show('My quizzes', '<div class="pane"><h2>My quizzes</h2><p class="sub">Make your own quiz for your class or friends. Quizzes are saved on this device. Use <b>Download</b> to keep a copy or move it to another computer, and <b>Share</b> to give a link to another teacher.</p>' +
      '<table class="servers"><tbody>' + (rows || '<tr><td class="empty">No quizzes yet. Click <b>New quiz</b> to make one.</td></tr>') + '</tbody></table>' +
      '<div class="row"><button class="aero" data-act="home">Back</button><span class="grow"></span><label class="aero filebtn">Open a quiz file<input type="file" id="qimport" accept=".smartquiz,.json,application/json" hidden></label><button class="aero primary big" data-act="qnew">New quiz</button></div></div>');
  }

  function editQuiz (quiz) {
    stopAll();
    app.draft = JSON.parse(JSON.stringify(quiz));
    renderEditor();
  }
  function renderEditor (focusLast) {
    var d = app.draft;
    var cards = d.questions.map(function (r, i) {
      var answers = [1, 2, 3, 4].map(function (k) {
        var right = k === 1;
        return '<label class="ansrow a' + (k - 1) + 'b"><span class="l">' + (right ? '&#10004;' : '&#10008;') + '</span><input data-f="a" data-i="' + i + '" data-k="' + k + '" maxlength="' + LIMITS.answer + '" value="' + esc(r[k]) + '" placeholder="' + (right ? 'Right answer' : 'Wrong answer') + '"></label>';
      }).join('');
      return '<fieldset class="qcard"><legend>Question ' + (i + 1) + '</legend>' +
        '<textarea data-f="q" data-i="' + i + '" maxlength="' + LIMITS.text + '" rows="2" placeholder="Type the question">' + esc(r[0]) + '</textarea>' +
        '<div class="ansgrid">' + answers + '</div><div class="qtools"><span class="small">Put the right answer in the first box. Answers are mixed up when you play.</span><span class="grow"></span>' +
        '<button class="aero" data-act="qup" data-i="' + i + '"' + (i ? '' : ' disabled') + ' title="Move up">&#9650;</button><button class="aero" data-act="qdown" data-i="' + i + '"' + (i < d.questions.length - 1 ? '' : ' disabled') + ' title="Move down">&#9660;</button>' +
        '<button class="aero" data-act="qrm" data-i="' + i + '">Remove</button></div></fieldset>';
    }).join('');
    show('Quiz maker', '<div class="pane"><h2>Quiz maker</h2>' +
      '<label class="field">Title <input data-f="title" maxlength="' + LIMITS.title + '" value="' + esc(d.title) + '" placeholder="e.g. Class 5 Science"></label>' +
      cards +
      '<div class="row"><button class="aero" data-act="qadd"' + (d.questions.length >= LIMITS.questions ? ' disabled' : '') + '>+ Add question</button><span class="small">' + d.questions.length + ' of ' + LIMITS.questions + '</span></div>' +
      '<div class="row"><button class="aero" data-act="qcancel">Cancel</button><span class="grow"></span><button class="aero primary big" data-act="qsave">Save quiz</button></div></div>');
    if (focusLast) {
      var all = $win.querySelectorAll('textarea[data-f=q]');
      if (all.length) { all[all.length - 1].focus(); all[all.length - 1].scrollIntoView({block: 'center'}); }
    }
  }
  document.addEventListener('input', function (e) {
    var t = e.target;
    if (!app.draft || !t.getAttribute) return;
    var f = t.getAttribute('data-f');
    var i = parseInt(t.getAttribute('data-i'), 10);
    if (f === 'title') app.draft.title = t.value;
    else if (f === 'q') app.draft.questions[i][0] = t.value;
    else if (f === 'a') app.draft.questions[i][parseInt(t.getAttribute('data-k'), 10)] = t.value;
  });
  document.addEventListener('change', function (e) {
    if (!e.target || e.target.id !== 'qimport' || !e.target.files[0]) return;
    var file = e.target.files[0];
    if (file.size > 500000) { flash('That file is too big to be a quiz.'); return; }
    file.text().then(function (text) {
      var q = cleanQuiz(JSON.parse(text));
      if (!q || !q.questions.length) throw new Error('empty');
      q.id = 'q' + Date.now().toString(36);
      var list = loadQuizzes(); list.push(q);
      if (storeQuizzes(list)) { flash('Opened "' + q.title + '".'); myQuizzes(); }
    }).catch(function () { flash('That isn\'t a SmartLearning quiz file.'); });
  });
  function saveDraft () {
    var q = cleanQuiz(app.draft);
    var bad = quizProblems(q);
    if (bad.length) { flash(bad[0]); return false; }
    q.id = app.draft.id;
    var list = loadQuizzes().filter(function (x) { return x.id !== q.id; });
    list.push(q);
    if (!storeQuizzes(list)) return false;
    app.draft = null;
    flash('Saved "' + q.title + '".');
    return true;
  }
  function download (name, text) {
    var a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([text], {type: 'application/json'}));
    a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
  }

  // ---------- menus ----------
  function stopAll () {
    if (app.host) { app.host.close(); app.host = null; }
    if (app.player) { app.player.leave(); app.player = null; }
    if (app.finder) { app.finder.stop(); app.finder = null; }
  }

  function home () {
    stopAll();
    app.draft = null;
    var m = me();
    var swatches = COLORS.map(function (c) { return '<button class="sw' + (c === m.color ? ' on' : '') + '" data-act="color" data-c="' + c + '" style="background:' + c + '" title="Pick this colour"></button>'; }).join('');
    show('', '<div class="pane"><div class="hero">' + stick(m.color, 96, 'win') + '<div><h1>SmartLearning</h1><p class="sub">A stickman quiz for up to 32 players. Play with friends on any phone, tablet or computer.</p></div></div>' +
      '<fieldset><legend>You</legend><label class="field">Name <input id="name" maxlength="16" placeholder="Your nickname" value="' + esc(saved('name', '')) + '" autocomplete="off"></label>' +
      '<div class="field">Colour <span class="sws">' + swatches + '</span></div><p class="small">Use a nickname, not your real name.</p></fieldset>' +
      '<div class="tiles">' +
      '<button class="tile" data-act="hostsetup"><span class="ti">&#127918;</span><b>Host a game</b><span>Make a room. Friends join with a QR code or room code.</span></button>' +
      '<button class="tile" data-act="code"><span class="ti">&#128273;</span><b>Join with code</b><span>Type the 6-digit code from the host\'s screen.</span></button>' +
      '<button class="tile" data-act="find"><span class="ti">&#128269;</span><b>Find a server</b><span>See public rooms and jump in.</span></button>' +
      '<button class="tile" data-act="myquizzes"><span class="ti">&#9999;&#65039;</span><b>Make a quiz</b><span>Teachers: write your own questions, save them and host them.</span></button>' +
      '<button class="tile" data-act="practice"><span class="ti">&#128218;</span><b>Practice alone</b><span>Play a quiz by yourself, no internet needed.</span></button>' +
      '</div></div>');
  }

  function catOptions (sel) {
    var html = '<option value="mixed"' + (sel === 'mixed' ? ' selected' : '') + '>&#127922; Mixed (all topics)</option>';
    Object.keys(Q).forEach(function (k) { html += '<option value="' + k + '"' + (sel === k ? ' selected' : '') + '>' + Q[k].icon + ' ' + esc(Q[k].name) + ' (' + Q[k].q.length + ')</option>'; });
    var mine = loadQuizzes();
    if (mine.length) {
      html += '<optgroup label="My quizzes">' + mine.map(function (q) {
        return '<option value="my:' + q.id + '"' + (sel === 'my:' + q.id ? ' selected' : '') + '>&#9999;&#65039; ' + esc(q.title) + ' (' + q.questions.length + ')</option>';
      }).join('') + '</optgroup>';
    }
    return html;
  }

  function hostSetup (practice) {
    stopAll();
    var m = me();
    show(practice ? 'Practice' : 'Host a game', '<div class="pane"><h2>' + (practice ? 'Practice alone' : 'Host a game') + '</h2>' +
      '<fieldset><legend>Quiz</legend>' +
      (practice ? '' : '<label class="field">Room name <input id="room" maxlength="24" value="' + esc(saved('room', m.name + '\'s room')) + '"></label>') +
      '<label class="field">Topic <select id="cat">' + catOptions(saved('cat', 'mixed')) + '</select></label>' +
      '<label class="field">Questions <select id="count"><option>5</option><option' + (/^my:/.test(saved('cat', '')) ? '' : ' selected') + '>10</option><option>15</option><option>20</option><option value="999"' + (/^my:/.test(saved('cat', '')) ? ' selected' : '') + '>All</option></select></label>' +
      '<label class="field">Time per question <select id="time"><option value="10">10 seconds</option><option value="20" selected>20 seconds</option><option value="30">30 seconds</option></select></label></fieldset>' +
      (practice ? '' : '<fieldset><legend>Room</legend>' +
      '<label class="check"><input type="checkbox" id="public" checked> Show my room in <b>Find a server</b></label>' +
      '<label class="check"><input type="checkbox" id="plays"> I play too (answer on this screen)</label>' +
      '<label class="check"><input type="checkbox" id="auto" checked> Go to the next question by itself</label></fieldset>') +
      '<div class="row"><button class="aero" data-act="home">Back</button><span class="grow"></span><button class="aero primary big" data-act="' + (practice ? 'startpractice' : 'create') + '">' + (practice ? 'Start &#9654;' : 'Create room &#9654;') + '</button></div></div>');
  }

  function joinCode (prefill) {
    stopAll();
    show('Join with code', '<div class="pane center"><h2>Join with code</h2><p class="sub">Type the 6-digit room code from the host\'s screen.</p>' +
      '<input id="code" class="codein" inputmode="numeric" maxlength="7" placeholder="123 456" value="' + esc(prefill || '') + '" autocomplete="off">' +
      '<div class="row"><button class="aero" data-act="home">Back</button><span class="grow"></span><button class="aero primary big" data-act="join">Join &#9654;</button></div></div>');
    var el = document.getElementById('code');
    if (el) el.focus();
  }

  function ensureName () {
    var input = document.getElementById('name');
    if (input) save('name', cleanName(input.value));
    if (!saved('name', '')) save('name', cleanName(''));
  }

  function joinRoom (code) {
    code = String(code || '').replace(/\D/g, '');
    if (code.length !== 6) { flash('Room codes have 6 digits.'); return; }
    ensureName();
    stopAll();
    app.player = new Player(code);
  }

  // ---------- clicks ----------
  document.addEventListener('click', function (e) {
    var b = e.target.closest('[data-act]');
    if (!b || b.disabled) return;
    var act = b.getAttribute('data-act');
    if (act !== 'ans' && act !== 'pans') sfx.click();
    if (act === 'home') home();
    else if (act === 'color') { ensureName(); save('color', b.getAttribute('data-c')); home(); }
    else if (act === 'hostsetup') { ensureName(); hostSetup(false); }
    else if (act === 'practice') { ensureName(); hostSetup(true); }
    else if (act === 'code') { ensureName(); joinCode(); }
    else if (act === 'find') { ensureName(); stopAll(); app.finder = new Finder(); }
    else if (act === 'join') joinRoom(document.getElementById('code').value);
    else if (act === 'joincode') joinRoom(b.getAttribute('data-code'));
    else if (act === 'create' || act === 'startpractice') {
      var practice = act === 'startpractice';
      var opts = {
        room: practice ? 'Practice' : cleanName(document.getElementById('room').value || me().name + '\'s room').slice(0, 24),
        cat: document.getElementById('cat').value,
        count: parseInt(document.getElementById('count').value, 10),
        time: parseInt(document.getElementById('time').value, 10),
        public: practice ? false : document.getElementById('public').checked,
        plays: practice ? true : document.getElementById('plays').checked,
        auto: practice ? true : document.getElementById('auto').checked,
        local: practice
      };
      if (!practice) save('room', opts.room);
      save('cat', opts.cat);
      stopAll();
      app.host = new Host(opts);
      app.host.render();
      if (practice) app.host.start();
    } else if (act === 'myquizzes') { ensureName(); myQuizzes(); }
    else if (act === 'qnew') editQuiz({id: 'q' + Date.now().toString(36), title: '', questions: [['', '', '', '', '']]});
    else if (act === 'qedit') { var eq = getQuiz(b.getAttribute('data-id')); if (eq) editQuiz(eq); }
    else if (act === 'qadd') { app.draft.questions.push(['', '', '', '', '']); renderEditor(true); }
    else if (act === 'qrm') { app.draft.questions.splice(parseInt(b.getAttribute('data-i'), 10), 1); renderEditor(); }
    else if (act === 'qup' || act === 'qdown') {
      var qi = parseInt(b.getAttribute('data-i'), 10); var qj = act === 'qup' ? qi - 1 : qi + 1;
      var qs = app.draft.questions; var tmp = qs[qi]; qs[qi] = qs[qj]; qs[qj] = tmp; renderEditor();
    }
    else if (act === 'qsave') { if (saveDraft()) myQuizzes(); }
    else if (act === 'qcancel') { app.draft = null; myQuizzes(); }
    else if (act === 'qdel') {
      var dq = getQuiz(b.getAttribute('data-id'));
      if (dq && window.confirm('Delete "' + dq.title + '"? This can\'t be undone.')) { storeQuizzes(loadQuizzes().filter(function (x) { return x.id !== dq.id; })); myQuizzes(); }
    }
    else if (act === 'qexport') { var xq = getQuiz(b.getAttribute('data-id')); if (xq) download((xq.title.replace(/[^\w\- ]+/g, '').trim().replace(/\s+/g, '_') || 'quiz') + '.smartquiz', JSON.stringify({title: xq.title, questions: xq.questions}, null, 1)); }
    else if (act === 'qshare') {
      var sq = getQuiz(b.getAttribute('data-id'));
      if (sq) {
        var link = shareLink(sq);
        (navigator.clipboard ? navigator.clipboard.writeText(link) : Promise.reject()).then(function () { flash('Link copied! Anyone who opens it can save "' + sq.title + '".'); },
          function () { window.prompt('Copy this link:', link); });
      }
    }
    else if (act === 'qhost' || act === 'qplay') {
      save('cat', 'my:' + b.getAttribute('data-id'));
      hostSetup(act === 'qplay');
    }
    else if (act === 'qtake') {
      var tq = app.incoming; app.incoming = null;
      if (tq) { tq.id = 'q' + Date.now().toString(36); var tl = loadQuizzes(); tl.push(tq); if (storeQuizzes(tl)) flash('Saved "' + tq.title + '" to My quizzes.'); }
      history.replaceState(null, '', location.pathname + location.search);
      myQuizzes();
    }
    else if (act === 'start') app.host && app.host.start();
    else if (act === 'kick') app.host && app.host.kick(parseInt(b.getAttribute('data-pid'), 10));
    else if (act === 'skip') app.host && app.host.reveal();
    else if (act === 'next') app.host && app.host.next();
    else if (act === 'again') app.host && app.host.again();
    else if (act === 'quit') home();
    else if (act === 'ans') app.host && app.host.answerSelf(parseInt(b.getAttribute('data-a'), 10));
    else if (act === 'pans') app.player && app.player.pick(parseInt(b.getAttribute('data-a'), 10));
    else if (act === 'stay' && app.player) { app.player.state = 'lobby'; app.player.lobby = app.player.lobby || {pl: []}; app.player.render(); }
  });
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Enter' && document.getElementById('code') && document.activeElement && document.activeElement.id === 'code') joinRoom(document.getElementById('code').value);
    var n = ['1', '2', '3', '4'].indexOf(e.key);
    if (n < 0) n = ['a', 'b', 'c', 'd'].indexOf(String(e.key).toLowerCase());
    if (n >= 0 && document.activeElement && /INPUT|SELECT/.test(document.activeElement.tagName)) return;
    if (n >= 0 && app.player) app.player.pick(n);
    else if (n >= 0 && app.host) app.host.answerSelf(n);
  });
  document.addEventListener('change', function (e) {
    if (e.target && e.target.id === 'name') save('name', cleanName(e.target.value));
  });
  window.addEventListener('beforeunload', function () { stopAll(); });

  // taskbar clock
  function clock () {
    var d = new Date();
    document.getElementById('clock').innerHTML = d.toLocaleTimeString([], {hour: '2-digit', minute: '2-digit'}) + '<br>' + d.toLocaleDateString();
  }
  clock(); setInterval(clock, 15000);

  // a shared quiz link: #quiz=...
  var hashQuiz = /^#quiz=([\w-]+)$/.exec(location.hash);
  if (hashQuiz) {
    try { app.incoming = cleanQuiz(JSON.parse(unb64url(hashQuiz[1]))); } catch (e) { app.incoming = null; }
  }
  // ?join=123456 from a QR code goes straight into the room
  var joinParam = new URLSearchParams(location.search).get('join');
  if (joinParam) {
    if (saved('name', '')) joinRoom(joinParam);
    else {
      show('Join', '<div class="pane center">' + stick(me().color, 84, 'win') + '<h2>Join room ' + esc(joinParam) + '</h2><p class="sub">Pick a nickname first.</p>' +
        '<label class="field">Name <input id="name" maxlength="16" placeholder="Your nickname" autocomplete="off"></label>' +
        '<div class="row"><button class="aero" data-act="home">Menu</button><span class="grow"></span><button class="aero primary big" data-act="joincode" data-code="' + esc(joinParam) + '">Join &#9654;</button></div></div>');
    }
  } else if (app.incoming && app.incoming.questions.length) {
    show('Shared quiz', '<div class="pane center"><h2>Someone shared a quiz with you</h2><p class="sub"><b>' + esc(app.incoming.title) + '</b> &middot; ' + app.incoming.questions.length + ' questions</p>' +
      '<div class="row"><button class="aero" data-act="home">No thanks</button><span class="grow"></span><button class="aero primary big" data-act="qtake">Save to My quizzes</button></div></div>');
  } else {
    home();
  }

  window.SmartLearning = app; // handy for testing
})();
