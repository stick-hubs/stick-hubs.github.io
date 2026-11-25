/* WorkSheet++: daily worksheets on the days you choose, Duolingo style. */
(function () {
  var C = window.WSCourses;
  var KEY = 'worksheetpp-v1';
  var DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  var SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  var WEEK = [1, 2, 3, 4, 5, 6, 0]; // timetable starts on Monday
  var PASS = 8; // out of 10

  var $ = function (id) { return document.getElementById(id); };
  var content = $('content');
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function pad(n) { return (n < 10 ? '0' : '') + n; }
  function dateKey(d) { d = d || new Date(); return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); }
  function addDays(d, n) { var x = new Date(d); x.setDate(x.getDate() + n); return x; }
  function toast(text) { var t = $('toast'); t.textContent = text; t.hidden = false; clearTimeout(toast.t); toast.t = setTimeout(function () { t.hidden = true; }, 3500); }

  // ---------------------------------------------------------------- saved data
  var data;
  function fresh() { return { v: 1, xp: 0, streak: { count: 0, last: '' }, courses: [], updated: 0 }; }
  function load() { try { data = JSON.parse(localStorage.getItem(KEY)) || fresh(); } catch (e) { data = fresh(); } }
  var syncTimer = null;
  function save(skipSync) {
    data.updated = Date.now();
    try { localStorage.setItem(KEY, JSON.stringify(data)); } catch (e) { /* storage full */ }
    if (!skipSync && signedIn()) { clearTimeout(syncTimer); syncTimer = setTimeout(pushSync, 1500); }
  }
  function signedIn() { return !!(window.SH && SH.session()); }
  function pushSync() {
    SH.api('/ws/save', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ data: data }) })
      .then(function () { setSync('Saved to your account'); }, function (e) { setSync(/switched on/.test(e.message) ? 'Saved on this device' : 'Saved on this device (account sync failed)'); });
  }
  function pullSync() {
    if (!signedIn()) { setSync('Saved on this device · <a href="#" id="signin">sign in</a> to keep it on every device'); return; }
    SH.api('/ws/load').then(function (r) {
      if (r.data && r.data.updated > (data.updated || 0)) { data = r.data; save(true); route(); toast('Loaded your progress from your account'); }
      else if (data.courses.length) pushSync();
      setSync('Saved to your account');
    }, function () { setSync('Saved on this device'); });
  }
  var syncHtml = '';
  function setSync(html) { syncHtml = html; var el = $('sync'); if (el) el.innerHTML = html; }
  document.addEventListener('click', function (e) { if (e.target.id === 'signin') { e.preventDefault(); SH.signIn(); } });

  function course(id) { for (var i = 0; i < data.courses.length; i++) if (data.courses[i].id === id) return data.courses[i]; return null; }
  function info(c) {
    if (c.kind === 'custom') return { name: c.subject, icon: '✨', levels: null, max: 10 };
    var b = C.list[c.kind];
    return { name: b.name, icon: b.icon, levels: b.levels, max: b.levels.length };
  }
  function levelName(c, lv) { var i = info(c); return i.levels ? i.levels[lv - 1] : 'Level ' + lv; }
  function doneToday(c) { return c.history && c.history[dateKey()]; }
  function scheduledOn(c, day) { return c.days.indexOf(day) >= 0; }

  // A streak only breaks when a scheduled day passes with nothing done.
  function checkStreak() {
    var s = data.streak;
    if (!s.last) return;
    var d = addDays(new Date(s.last + 'T12:00'), 1), today = dateKey();
    while (dateKey(d) < today) {
      var day = d.getDay(), missed = data.courses.some(function (c) { return scheduledOn(c, day); });
      if (missed) { s.count = 0; break; }
      d = addDays(d, 1);
    }
  }
  function addStreak() {
    var today = dateKey();
    if (data.streak.last === today) return false;
    data.streak.count = (data.streak.count || 0) + 1;
    data.streak.last = today;
    return true;
  }

  // ---------------------------------------------------------------- frame
  function frame(tab, html) {
    var tabs = [['today', 'Today'], ['timetable', 'Timetable'], ['courses', 'My courses'], ['add', '+ Add a course']];
    content.innerHTML = '<div class="wsbar"><div class="stats"><span title="Streak">🔥 <b>' + (data.streak.count || 0) + '</b> day streak</span><span title="Experience points">⭐ <b>' + (data.xp || 0) + '</b> XP</span></div>' +
      '<nav class="wstabs">' + tabs.map(function (t) { return '<a href="#' + t[0] + '"' + (t[0] === tab ? ' class="on"' : '') + '>' + t[1] + '</a>'; }).join('') + '</nav></div>' +
      '<div class="pane">' + html + '</div><p class="small center" id="sync"></p>';
    $('sync').innerHTML = syncHtml;
  }

  // ---------------------------------------------------------------- today
  function viewToday() {
    checkStreak();
    var now = new Date(), day = now.getDay();
    if (!data.courses.length) {
      frame('today', '<div class="hero"><div class="ti" style="font-size:56px">📝</div><div><h1>Welcome to WorkSheet++</h1><p class="sub">Pick what you want to learn and which days. Every day you planned, a fresh worksheet is waiting for you.</p>' +
        '<a class="aero primary big" href="#add">Add your first course</a></div></div>');
      return;
    }
    var todays = data.courses.filter(function (c) { return scheduledOn(c, day); }).sort(function (a, b) { return a.time < b.time ? -1 : 1; });
    var others = data.courses.filter(function (c) { return !scheduledOn(c, day); });
    var allDone = todays.length && todays.every(doneToday);
    var html = '<h1>' + DAYS[day] + '</h1><p class="sub">' + (todays.length ? (allDone ? 'All done for today. Great work! 🎉' : 'Here are today\'s worksheets.') : 'Nothing planned today. You can still practise!') + '</p>';
    html += todays.map(sheetCard).join('');
    if (others.length) html += '<div class="grouphead"><span>Practise anything</span></div>' + others.map(sheetCard).join('');
    // what's next this week
    var next = [];
    for (var i = 1; i <= 6 && next.length < 3; i++) {
      var d = addDays(now, i);
      data.courses.forEach(function (c) { if (scheduledOn(c, d.getDay()) && next.length < 3) next.push((i === 1 ? 'Tomorrow' : DAYS[d.getDay()]) + ' ' + c.time + ' · ' + info(c).icon + ' ' + esc(info(c).name)); });
    }
    if (next.length) html += '<div class="grouphead"><span>Coming up</span></div><ul class="next">' + next.map(function (n) { return '<li>' + n + '</li>'; }).join('') + '</ul>';
    frame('today', html);
  }
  function sheetCard(c) {
    var i = info(c), h = doneToday(c);
    var status = h ? '<span class="done">' + (h.score >= Math.ceil(h.total * PASS / 10) ? '✔ ' : '') + h.score + '/' + h.total + '</span><a class="aero" href="#play/' + c.id + '">Practise again</a>' :
      '<a class="aero primary" href="#play/' + c.id + '">Start</a>';
    return '<div class="sheet' + (h ? ' is-done' : '') + '"><div class="ic">' + i.icon + '</div><div class="grow"><b>' + esc(i.name) + '</b><div class="small">Level ' + c.level + ': ' + esc(levelName(c, c.level)) +
      (scheduledOn(c, new Date().getDay()) ? ' · ' + c.time : '') + '</div>' + levelBar(c) + '</div>' + status + '</div>';
  }
  function levelBar(c) {
    var need = 2, have = Math.min(need, c.passes || 0);
    return '<div class="lvbar" title="Pass ' + need + ' worksheets with ' + PASS + '/10 or better to level up"><i style="width:' + (100 * have / need) + '%"></i></div>';
  }

  // ---------------------------------------------------------------- timetable
  function viewTimetable() {
    var today = new Date().getDay();
    var cols = WEEK.map(function (d) {
      var items = data.courses.filter(function (c) { return scheduledOn(c, d); }).sort(function (a, b) { return a.time < b.time ? -1 : 1; });
      return '<div class="daycol' + (d === today ? ' today' : '') + '"><div class="dayname">' + SHORT[d] + '</div>' +
        (items.length ? items.map(function (c) { return '<a class="chip" href="#edit/' + c.id + '"><b>' + c.time + '</b> ' + info(c).icon + ' ' + esc(info(c).name) + '</a>'; }).join('') : '<span class="free">Free</span>') + '</div>';
    }).join('');
    frame('timetable', '<h1>My timetable</h1><p class="sub">Click a lesson to change its days or time.</p><div class="week">' + cols + '</div>' +
      (data.courses.length ? '' : '<p>Your week is empty. <a href="#add">Add a course</a> to fill it.</p>'));
  }

  // ---------------------------------------------------------------- courses
  function viewCourses() {
    if (!data.courses.length) { frame('courses', '<h1>My courses</h1><p>No courses yet. <a href="#add">Add one</a>.</p>'); return; }
    frame('courses', '<h1>My courses</h1>' + data.courses.map(function (c) {
      var i = info(c), max = i.max, path = '';
      for (var lv = 1; lv <= max; lv++) {
        var cls = lv < c.level ? 'past' : lv === c.level ? 'now' : 'locked';
        path += '<span class="node ' + cls + '" title="Level ' + lv + ': ' + esc(levelName(c, lv)) + '">' + (lv < c.level ? '✔' : lv === c.level ? '★' : lv) + '</span>';
      }
      return '<fieldset class="course"><legend>' + i.icon + ' ' + esc(i.name) + '</legend>' +
        (c.kind === 'custom' && c.goal ? '<p class="small">' + esc(c.goal) + '</p>' : '') +
        '<div class="path">' + path + '</div><p>Now: <b>Level ' + c.level + '</b> · ' + esc(levelName(c, c.level)) + '</p>' + levelBar(c) +
        '<p class="small">' + (c.days.length ? c.days.slice().sort(function (a, b) { return WEEK.indexOf(a) - WEEK.indexOf(b); }).map(function (d) { return SHORT[d]; }).join(', ') + ' at ' + c.time : 'No days picked') + '</p>' +
        '<div class="row"><a class="aero primary" href="#play/' + c.id + '">Practise now</a>' +
        (c.level < max ? '<a class="aero" href="#skip/' + c.id + '">Skip ahead test</a>' : '') +
        '<a class="aero" href="#edit/' + c.id + '">Days and time</a><button class="x" data-remove="' + c.id + '" title="Remove course">Remove</button></div></fieldset>';
    }).join(''));
  }
  content.addEventListener('click', function (e) {
    var rm = e.target.closest('[data-remove]');
    if (rm && confirm('Remove this course and its progress?')) {
      data.courses = data.courses.filter(function (c) { return c.id !== rm.getAttribute('data-remove'); });
      save(); route();
    }
  });

  // ---------------------------------------------------------------- add / edit
  function scheduleFields(c) {
    return '<fieldset><legend>When do you want to learn?</legend><div class="days">' + WEEK.map(function (d) {
      return '<label class="daypick"><input type="checkbox" name="day" value="' + d + '"' + (c.days.indexOf(d) >= 0 ? ' checked' : '') + '><span>' + SHORT[d] + '</span></label>';
    }).join('') + '</div><div class="field"><label for="time">Time</label><input id="time" name="time" type="time" value="' + esc(c.time) + '" style="min-width:0"></div></fieldset>';
  }
  function readSchedule(form) {
    return {
      days: Array.prototype.slice.call(form.querySelectorAll('input[name=day]:checked')).map(function (x) { return +x.value; }),
      time: form.time.value || '16:00'
    };
  }
  function viewAdd(kind) {
    if (!kind) {
      frame('add', '<h1>Add a course</h1><p class="sub">What do you want to learn?</p><div class="tiles">' +
        '<a class="tile" href="#add/fractions"><span class="ti">🍕</span><b>Fractions</b><span>Maths from counting all the way to fractions, decimals and percent. 10 levels.</span></a>' +
        '<a class="tile" href="#add/english"><span class="ti">🇬🇧</span><b>English</b><span>Words, sentences, grammar, reading stories and spelling. 5 levels.</span></a>' +
        '<a class="tile" href="#add/custom"><span class="ti">✨</span><b>Anything else</b><span>German, science, history… Write what you want and the AI makes your worksheets.</span></a></div>');
      return;
    }
    var c = { kind: kind, days: [new Date().getDay()], time: '16:00', level: 1 };
    var extra = kind === 'custom' ?
      '<fieldset><legend>What do you want to learn?</legend><div class="field"><label for="subject">Subject</label><input id="subject" name="subject" maxlength="120" required placeholder="German for beginners"></div>' +
      '<div class="field"><label for="goal">More details</label><input id="goal" name="goal" maxlength="300" placeholder="Animals, colours and saying hello (optional)"></div>' +
      '<div class="field"><label for="lvl">How good are you now?</label><input id="lvl" name="lvl" type="range" min="1" max="10" value="1" style="min-width:160px"><span id="lvlv">1 · total beginner</span></div>' +
      '<p class="small">The AI makes a new worksheet for you on each of your days. You need a Stick Hubs account, and it can make a few free worksheets per person each day.</p></fieldset>' :
      '<fieldset><legend>Where do you start?</legend><div class="field"><select name="start">' + C.list[kind].levels.map(function (n, i) { return '<option value="' + (i + 1) + '">Level ' + (i + 1) + ': ' + esc(n) + '</option>'; }).join('') + '</select></div>' +
      '<p class="small">Not sure? Start at level 1. You can skip ahead later with a quick test.</p></fieldset>';
    var name = kind === 'custom' ? 'your own course' : C.list[kind].name;
    frame('add', '<h1>Add ' + esc(name) + '</h1><form id="addform">' + extra + scheduleFields(c) + '<div class="row"><button class="aero primary big" type="submit">Add course</button><a class="aero" href="#add">Back</a></div></form>');
    var f = $('addform');
    if (f.lvl) f.lvl.addEventListener('input', function () { $('lvlv').textContent = f.lvl.value + (f.lvl.value == 1 ? ' · total beginner' : f.lvl.value >= 9 ? ' · very good' : ''); });
    f.addEventListener('submit', function (e) {
      e.preventDefault();
      var s = readSchedule(f);
      if (!s.days.length) { toast('Pick at least one day.'); return; }
      if (kind !== 'custom' && data.courses.some(function (x) { return x.kind === kind; })) { toast('You already have this course.'); return; }
      var nc = { id: kind === 'custom' ? 'c' + Date.now().toString(36) : kind, kind: kind, days: s.days, time: s.time, level: kind === 'custom' ? +f.lvl.value : +f.start.value, passes: 0, history: {}, mistakes: [] };
      if (kind === 'custom') { nc.subject = f.subject.value.trim(); nc.goal = f.goal.value.trim(); if (!nc.subject) return; }
      data.courses.push(nc);
      save();
      toast('Added! It\'s on your timetable.');
      location.hash = '#today';
    });
  }
  function viewEdit(id) {
    var c = course(id);
    if (!c) { location.hash = '#timetable'; return; }
    frame('timetable', '<h1>' + info(c).icon + ' ' + esc(info(c).name) + '</h1><form id="editform">' + scheduleFields(c) + '<div class="row"><button class="aero primary" type="submit">Save</button><a class="aero" href="#timetable">Cancel</a></div></form>');
    $('editform').addEventListener('submit', function (e) {
      e.preventDefault();
      var s = readSchedule(e.target);
      if (!s.days.length) { toast('Pick at least one day.'); return; }
      c.days = s.days; c.time = s.time;
      save(); location.hash = '#timetable';
    });
  }

  // ---------------------------------------------------------------- playing a worksheet
  var play = null;
  function getSheet(c, mode) {
    var seed = dateKey() + (mode === 'skip' ? '|skip' : doneToday(c) ? '|extra' + Object.keys(c.history).length + (play && play.round || 0) : '');
    var level = mode === 'skip' ? c.level + 1 : c.level;
    if (c.kind !== 'custom') return Promise.resolve({ title: info(c).name, questions: C.worksheet(c.kind, level, seed, mode === 'skip' ? [] : c.mistakes) });
    if (c.cache && c.cache.date === dateKey() && c.cache.level === level && !doneToday(c)) return Promise.resolve(c.cache);
    if (!signedIn()) return Promise.reject(new Error('Sign in to Stick Hubs so the AI can make your worksheet.'));
    return SH.api('/ws/generate', { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ subject: c.subject, goal: c.goal, level: level, mistakes: (c.mistakes || []).slice(0, 5).map(function (m) { return m.q; }) }) })
      .then(function (r) { c.cache = { date: dateKey(), level: level, title: r.title, questions: r.questions }; save(); return c.cache; });
  }
  function viewPlay(id, mode) {
    var c = course(id);
    if (!c) { location.hash = '#today'; return; }
    content.innerHTML = '<div class="pane center"><h2>Making your worksheet…</h2><p class="sub">' + info(c).icon + ' ' + esc(info(c).name) + '</p></div>';
    getSheet(c, mode).then(function (sheet) {
      play = { c: c, mode: mode, qs: sheet.questions.slice(0, 12), title: sheet.title, i: 0, right: 0, wrong: [], round: (play && play.round || 0) + 1 };
      question();
    }, function (e) {
      content.innerHTML = '<div class="pane center"><h2>Couldn\'t make the worksheet</h2><p>' + esc(e.message) + '</p><div class="row" style="justify-content:center">' +
        (/Sign in/.test(e.message) ? '<button class="aero primary" id="signin2">Sign in</button>' : '<a class="aero primary" href="#play/' + c.id + '">Try again</a>') + '<a class="aero" href="#today">Back</a></div></div>';
      var b = $('signin2'); if (b) b.onclick = function () { SH.signIn(); };
    });
  }
  function question() {
    var q = play.qs[play.i], n = play.qs.length;
    var html = '<div class="pane player"><div class="qhead"><a href="#today" class="quit" title="Stop">✕</a><div class="prog"><i style="width:' + (100 * play.i / n) + '%"></i></div><span>' + (play.i + 1) + ' / ' + n + '</span></div>';
    if (play.mode === 'skip') html += '<p class="small center">Skip ahead test: get ' + PASS + ' right to jump to level ' + (play.c.level + 1) + '.</p>';
    if (q.story) html += '<div class="story">📖 ' + esc(q.story) + '</div>';
    html += '<div class="question">' + esc(q.q) + '</div>' + (q.pic ? '<div class="pic">' + q.pic + '</div>' : '');
    if (q.type === 'choice') {
      html += '<div class="answers' + (q.bigOptions ? ' big' : '') + '">' + q.options.map(function (o, k) {
        return '<button class="ans a' + (k % 4) + '" data-k="' + k + '"><span class="l">' + 'ABCD'[k] + '</span><span class="t">' + esc(o) + '</span></button>';
      }).join('') + '</div>';
    } else if (q.type === 'type') {
      html += '<form id="typeform" class="typeform"><input id="typed" autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="Type your answer"><button class="aero primary big" type="submit">Check</button></form>';
    } else {
      html += '<div class="built" id="built"></div><div class="wordbank">' + q.words.map(function (w, k) { return '<button class="word" data-w="' + k + '">' + esc(w) + '</button>'; }).join('') +
        '</div><div class="row" style="justify-content:center"><button class="aero primary big" id="checkorder">Check</button></div>';
    }
    html += '<div id="feedback"></div></div>';
    content.innerHTML = html;
    if (q.type === 'choice') {
      content.querySelectorAll('.ans').forEach(function (b) { b.onclick = function () { answer(+b.getAttribute('data-k') === q.answer, b); }; });
    } else if (q.type === 'type') {
      var input = $('typed'); input.focus();
      $('typeform').onsubmit = function (e) { e.preventDefault(); if (input.value.trim()) answer(C.check(q, input.value)); };
    } else {
      var built = [];
      var draw = function () { $('built').innerHTML = built.map(function (k, idx) { return '<button class="word" data-b="' + idx + '">' + esc(q.words[k]) + '</button>'; }).join('') || '<span class="small">Tap the words below</span>';
        content.querySelectorAll('.wordbank .word').forEach(function (b) { b.disabled = built.indexOf(+b.getAttribute('data-w')) >= 0; }); };
      content.querySelector('.wordbank').onclick = function (e) { var b = e.target.closest('[data-w]'); if (b && !b.disabled) { built.push(+b.getAttribute('data-w')); draw(); } };
      $('built').onclick = function (e) { var b = e.target.closest('[data-b]'); if (b) { built.splice(+b.getAttribute('data-b'), 1); draw(); } };
      $('checkorder').onclick = function () { if (built.length) answer(built.map(function (k) { return q.words[k]; }).join(' ') === q.answer); };
      draw();
    }
  }
  function answer(ok, button) {
    var q = play.qs[play.i];
    content.querySelectorAll('.ans, .word, #typed, #checkorder, #typeform button').forEach(function (b) { b.disabled = true; });
    if (q.type === 'choice') {
      content.querySelectorAll('.ans').forEach(function (b, k) { if (k === q.answer) b.classList.add('right'); else if (b !== button) b.classList.add('dim'); });
      if (button && !ok) button.classList.add('picked');
    }
    if (ok) play.right++; else play.wrong.push(q);
    var rightText = q.type === 'choice' ? q.options[q.answer] : q.answer;
    $('feedback').innerHTML = '<div class="fb ' + (ok ? 'good' : 'bad') + '"><b>' + (ok ? pickOne(['Correct! ✔', 'Nice one! ✔', 'Great job! ✔', 'Yes! ✔']) : 'Not quite') + '</b>' +
      (ok ? '' : '<div>Right answer: <b>' + esc(rightText) + '</b></div>') + (q.explain ? '<div class="small">' + esc(q.explain) + '</div>' : '') +
      '<div class="row"><button class="aero primary big" id="next">' + (play.i + 1 < play.qs.length ? 'Continue' : 'Finish') + '</button><a href="#" id="report" class="small">Problem with this question?</a></div></div>';
    var next = $('next'); next.focus();
    next.onclick = function () { play.i++; if (play.i < play.qs.length) question(); else finish(); };
    $('report').onclick = function (e) {
      e.preventDefault();
      var note = prompt('What is wrong with this question? (for example: the answer is wrong)');
      if (!note) return;
      if (!signedIn()) { toast('Thanks! Sign in to send reports to the owner.'); return; }
      SH.api('/ws/feedback', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ course: info(play.c).name, question: q.q + ' → ' + rightText, note: note }) })
        .then(function () { toast('Thanks! The owner will check it.'); }, function (err) { toast(err.message); });
    };
  }
  function pickOne(list) { return list[Math.floor(Math.random() * list.length)]; }

  function finish() {
    var c = play.c, n = play.qs.length, score = play.right, pass = score >= Math.ceil(n * PASS / 10), today = dateKey(), msg = '', gained;
    // mistakes come back on later worksheets; ones answered right are cleared
    var wrongQs = {}; play.wrong.forEach(function (q) { wrongQs[q.q] = 1; });
    c.mistakes = (c.mistakes || []).filter(function (m) { return wrongQs[m.q] || !play.qs.some(function (q) { return q.q === m.q; }); });
    play.wrong.forEach(function (q) { if (!c.mistakes.some(function (m) { return m.q === q.q; })) c.mistakes.unshift(q); });
    c.mistakes = c.mistakes.slice(0, 20);
    if (play.mode === 'skip') {
      gained = 5 + score;
      if (pass) { c.level++; c.passes = 0; msg = 'You passed! You jumped to level ' + c.level + ': ' + levelName(c, c.level) + '.'; }
      else msg = 'Not this time. Keep practising and try again later!';
    } else {
      var first = !doneToday(c);
      gained = (first ? 10 : 5) + score + (score === n ? 5 : 0);
      if (first) c.history[today] = { score: score, total: n };
      if (pass) {
        c.passes = (c.passes || 0) + (score === n ? 2 : 1);
        if (c.passes >= 2 && c.level < info(c).max) { c.level++; c.passes = 0; msg = 'Level up! 🎉 You\'re now on level ' + c.level + ': ' + levelName(c, c.level) + '.'; }
      }
    }
    data.xp = (data.xp || 0) + gained;
    var streakUp = addStreak();
    save();
    var stars = score === n ? '🏆' : pass ? '🌟' : '💪';
    content.innerHTML = '<div class="pane center wsresult"><div style="font-size:64px">' + stars + '</div><h1>' + score + ' / ' + n + '</h1>' +
      '<p class="sub">' + (score === n ? 'Perfect worksheet!' : pass ? 'Great work!' : 'Good try! The ones you missed will come back so you can learn them.') + '</p>' +
      '<p class="xpgain">+' + gained + ' XP' + (streakUp ? ' · 🔥 ' + data.streak.count + ' day streak!' : '') + '</p>' + (msg ? '<p class="levelmsg">' + esc(msg) + '</p>' : '') +
      '<div class="row" style="justify-content:center"><a class="aero primary big" href="#today">Done</a><a class="aero big" href="#play/' + c.id + '">Practise more</a></div></div>';
  }

  // ---------------------------------------------------------------- reminders while the page is open
  function remind() {
    var now = new Date(), hm = pad(now.getHours()) + ':' + pad(now.getMinutes());
    data.courses.forEach(function (c) {
      if (scheduledOn(c, now.getDay()) && c.time === hm && !doneToday(c)) {
        toast('⏰ Time for ' + info(c).name + '!');
        try { if (window.Notification && Notification.permission === 'granted') new Notification('WorkSheet++', { body: 'Time for ' + info(c).name + '!' }); } catch (e) { /* no notifications */ }
      }
    });
  }

  // ---------------------------------------------------------------- routing
  function route() {
    var h = location.hash.replace(/^#/, '').split('/');
    if (h[0] !== 'play' && h[0] !== 'skip') play = null;
    switch (h[0]) {
      case 'timetable': return viewTimetable();
      case 'courses': return viewCourses();
      case 'add': return viewAdd(h[1]);
      case 'edit': return viewEdit(h[1]);
      case 'play': return viewPlay(h[1], 'daily');
      case 'skip': return viewPlay(h[1], 'skip');
      default: return viewToday();
    }
  }
  window.addEventListener('hashchange', route);
  window.addEventListener('storage', function (e) { if (e.key === KEY && !play) { load(); route(); } });
  load();
  route();
  // account.js loads after this file: check the account once it's there
  window.addEventListener('load', function () { if (window.SH) pullSync(); else setSync('Saved on this device'); });
  setInterval(remind, 60000);
  var clock = $('clock');
  if (clock) { var tick = function () { var d = new Date(); clock.innerHTML = pad(d.getHours()) + ':' + pad(d.getMinutes()) + '<br>' + d.toLocaleDateString(); }; tick(); setInterval(tick, 10000); }
})();
