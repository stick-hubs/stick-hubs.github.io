/* WorkSheet++ built-in courses. Every worksheet is made by code from a seed (the date, the course and the level),
   so each day brings new questions, and the same day always gives the same worksheet. No AI needed.
   Question shapes:
     {type:'choice', q, options:[...], answer: index, explain, pic?}
     {type:'type', q, answer: 'text', check: 'value'|'exact'|'percent'|'word', explain, pic?}
     {type:'order', q, words:[...shuffled], answer:'the right sentence', explain} */
(function () {
  // ---------------------------------------------------------------- random numbers from a seed
  function rng(seed) {
    var h = 1779033703 ^ seed.length;
    for (var i = 0; i < seed.length; i++) { h = Math.imul(h ^ seed.charCodeAt(i), 3432918353); h = h << 13 | h >>> 19; }
    var a = h >>> 0;
    var r = function () { a |= 0; a = a + 0x6D2B79F5 | 0; var t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; };
    r.int = function (lo, hi) { return lo + Math.floor(r() * (hi - lo + 1)); };
    r.pick = function (list) { return list[Math.floor(r() * list.length)]; };
    r.shuffle = function (list) { list = list.slice(); for (var i = list.length - 1; i > 0; i--) { var j = Math.floor(r() * (i + 1)); var t = list[i]; list[i] = list[j]; list[j] = t; } return list; };
    return r;
  }

  // Multiple choice from a right answer and wrong ones (no doubles, shuffled).
  function choice(r, q, right, wrongs, explain, pic) {
    var seen = {}, opts = [String(right)];
    seen[String(right)] = 1;
    wrongs.forEach(function (w) { w = String(w); if (!seen[w] && opts.length < 4) { seen[w] = 1; opts.push(w); } });
    opts = r.shuffle(opts);
    return { type: 'choice', q: q, options: opts, answer: opts.indexOf(String(right)), explain: explain || '', pic: pic };
  }

  // ---------------------------------------------------------------- fractions maths
  function gcd(a, b) { a = Math.abs(a); b = Math.abs(b); while (b) { var t = b; b = a % b; a = t; } return a || 1; }
  function simp(n, d) { var g = gcd(n, d); n /= g; d /= g; if (d < 0) { n = -n; d = -d; } return [n, d]; }
  function fstr(n, d) { var s = simp(n, d); return s[1] === 1 ? String(s[0]) : s[0] + '/' + s[1]; }
  // Reads "3/4", "1 1/2", "2", "0.5" or "50%" into a number (or NaN).
  function readNum(text) {
    var t = String(text).trim().replace(/,/g, '.').replace(/\s+/g, ' ');
    var m;
    if ((m = /^(-?\d+) (\d+)\/(\d+)$/.exec(t))) return +m[1] + (+m[1] < 0 ? -1 : 1) * m[2] / m[3];
    if ((m = /^(-?\d+)\/(\d+)$/.exec(t))) return +m[2] ? m[1] / m[2] : NaN;
    if ((m = /^(-?\d*\.?\d+)%$/.exec(t))) return m[1] / 100;
    if (/^-?\d*\.?\d+$/.test(t)) return +t;
    return NaN;
  }
  function norm(t) { return String(t).trim().replace(/\s+/g, ' ').replace(/[.!?]+$/, '').toLowerCase(); }
  // Is a typed answer right? 'value': any equal number (6/8 = 3/4 = 0.75), 'exact': written exactly, 'percent': 25 or 25%, else same words.
  function check(q, text) {
    if (q.check === 'value') { var v = readNum(text), want = readNum(q.answer); return !isNaN(v) && Math.abs(v - want) < 1e-9; }
    if (q.check === 'percent') { var t = String(text).trim(); return check({ check: 'value', answer: q.answer }, /%$/.test(t) ? t : t + '%'); }
    if (q.check === 'exact') return norm(text) === norm(q.answer);
    return norm(text).replace(/[’']/g, "'") === norm(q.answer).replace(/[’']/g, "'");
  }

  // A circle or bar with some parts shaded.
  function fracPic(r, n, d) {
    var colour = r.pick(['#4f93e6', '#5cbd59', '#efb53c', '#e9675d', '#9b6ad6']);
    if (r() < 0.5 && d <= 12) {
      var parts = '';
      for (var i = 0; i < d; i++) {
        var a0 = (i / d) * 2 * Math.PI - Math.PI / 2, a1 = ((i + 1) / d) * 2 * Math.PI - Math.PI / 2;
        var x0 = 60 + 50 * Math.cos(a0), y0 = 60 + 50 * Math.sin(a0), x1 = 60 + 50 * Math.cos(a1), y1 = 60 + 50 * Math.sin(a1);
        parts += '<path d="M60 60 L' + x0.toFixed(2) + ' ' + y0.toFixed(2) + ' A50 50 0 ' + (d === 1 ? 1 : 0) + ' 1 ' + x1.toFixed(2) + ' ' + y1.toFixed(2) + ' Z" fill="' + (i < n ? colour : '#fff') + '" stroke="#1e3287" stroke-width="2"/>';
      }
      if (d === 1) parts = '<circle cx="60" cy="60" r="50" fill="' + (n ? colour : '#fff') + '" stroke="#1e3287" stroke-width="2"/>';
      return '<svg viewBox="0 0 120 120" width="130" height="130" role="img" aria-label="' + n + ' of ' + d + ' parts shaded">' + parts + '</svg>';
    }
    var w = 240 / d, cells = '';
    for (var j = 0; j < d; j++) cells += '<rect x="' + (2 + j * w).toFixed(2) + '" y="2" width="' + w.toFixed(2) + '" height="46" fill="' + (j < n ? colour : '#fff') + '" stroke="#1e3287" stroke-width="2"/>';
    return '<svg viewBox="0 0 244 50" width="260" height="54" role="img" aria-label="' + n + ' of ' + d + ' parts shaded">' + cells + '</svg>';
  }

  var FR = {};
  FR[1] = function (r) { // numbers and counting
    var k = r.int(0, 4);
    if (k === 0) { var n = r.int(3, 15), e = r.pick(['🍎', '⭐', '🐟', '🌸', '⚽', '🚗']); return choice(r, 'How many are there?', n, [n - 1, n + 1, n + 2, n - 2].filter(function (x) { return x > 0; }), 'Count them one by one: there are ' + n + '.', '<div class="emojis">' + new Array(n + 1).join(e) + '</div>'); }
    if (k === 1) { var a = r.int(10, 990); return { type: 'type', q: 'What number comes right after ' + a + '?', answer: String(a + 1), check: 'value', explain: a + ' + 1 = ' + (a + 1) + '.' }; }
    if (k === 2) { var x = r.int(10, 999), y = r.int(10, 999); if (x === y) y++; return choice(r, 'Which number is bigger?', Math.max(x, y), [Math.min(x, y)], Math.max(x, y) + ' is bigger than ' + Math.min(x, y) + '.'); }
    if (k === 3) { var h = r.int(1, 9), t = r.int(0, 9), o = r.int(0, 9), num = h * 100 + t * 10 + o;
      if (r() < 0.5) return choice(r, 'In ' + num + ', what is the hundreds digit?', h, [t, o, (h + 1) % 10, (h + 2) % 10], 'The first of the three digits shows the hundreds: ' + h + '.');
      return choice(r, 'In ' + num + ', what is the tens digit?', t, [h, o, (t + 1) % 10, (t + 3) % 10], 'The middle digit shows the tens: ' + t + '.'); }
    var s = r.int(2, 10), st = r.int(1, 20), seq = [st, st + s, st + 2 * s, st + 3 * s];
    return { type: 'type', q: 'What comes next? ' + seq.join(', ') + ', …', answer: String(st + 4 * s), check: 'value', explain: 'It goes up by ' + s + ' each time.' };
  };
  FR[2] = function (r) { // adding and taking away
    var a = r.int(5, 99), b = r.int(2, 99), k = r.int(0, 3);
    if (k === 0) return { type: 'type', q: a + ' + ' + b + ' = ?', answer: String(a + b), check: 'value', explain: a + ' + ' + b + ' = ' + (a + b) + '.' };
    if (k === 1) { var big = Math.max(a, b), small = Math.min(a, b); return { type: 'type', q: big + ' − ' + small + ' = ?', answer: String(big - small), check: 'value', explain: big + ' − ' + small + ' = ' + (big - small) + '.' }; }
    if (k === 2) { var c = r.int(10, 50), total = c + r.int(5, 40); return { type: 'type', q: c + ' + ? = ' + total, answer: String(total - c), check: 'value', explain: total + ' − ' + c + ' = ' + (total - c) + '.' }; }
    var have = r.int(12, 60), gave = r.int(3, have - 2), who = r.pick(['Sinta', 'Budi', 'Max', 'Aisha', 'Leo']), thing = r.pick(['marbles', 'stickers', 'cards', 'sweets']);
    return choice(r, who + ' has ' + have + ' ' + thing + ' and gives away ' + gave + '. How many are left?', have - gave, [have + gave, have - gave + 1, have - gave - 1, gave], have + ' − ' + gave + ' = ' + (have - gave) + '.');
  };
  FR[3] = function (r) { // times tables
    var a = r.int(2, 12), b = r.int(2, 12), k = r.int(0, 2);
    if (k === 0) return { type: 'type', q: a + ' × ' + b + ' = ?', answer: String(a * b), check: 'value', explain: a + ' × ' + b + ' = ' + (a * b) + '.' };
    if (k === 1) return choice(r, a + ' × ' + b + ' = ?', a * b, [a * b + a, a * b - b, a * (b + 2), a + b], a + ' lots of ' + b + ' make ' + (a * b) + '.');
    return { type: 'type', q: a + ' × ? = ' + (a * b), answer: String(b), check: 'value', explain: (a * b) + ' ÷ ' + a + ' = ' + b + '.' };
  };
  FR[4] = function (r) { // dividing
    var b = r.int(2, 12), q = r.int(2, 12), a = b * q, k = r.int(0, 2);
    if (k === 0) return { type: 'type', q: a + ' ÷ ' + b + ' = ?', answer: String(q), check: 'value', explain: b + ' × ' + q + ' = ' + a + ', so ' + a + ' ÷ ' + b + ' = ' + q + '.' };
    if (k === 1) { var who = r.pick(['friends', 'children', 'teams', 'boxes']); return choice(r, a + ' sweets are shared equally between ' + b + ' ' + who + '. How many each?', q, [q + 1, q - 1, a - b, b], a + ' ÷ ' + b + ' = ' + q + '.'); }
    var rem = r.int(1, b - 1), n = a + rem;
    return choice(r, n + ' ÷ ' + b + ' = ?', q + ' r ' + rem, [q + ' r ' + (rem === 1 ? 2 : rem - 1), (q + 1) + ' r ' + rem, q + ''], b + ' × ' + q + ' = ' + a + ', and ' + rem + ' is left over.');
  };
  FR[5] = function (r) { // what a fraction is
    var d = r.int(2, 10), n = r.int(1, d - 1), k = r.int(0, 2);
    if (k === 0) return choice(r, 'What fraction is shaded?', n + '/' + d, [(d - n) + '/' + d, n + '/' + (d + 1), d + '/' + n, n + '/' + (d - n || 1)], n + ' of the ' + d + ' equal parts are shaded, so ' + n + '/' + d + '.', fracPic(r, n, d));
    if (k === 1) { var dd = r.pick([2, 3, 4, 5, 10]), m = r.int(2, 9) * dd, nn = r.int(1, dd - 1); return { type: 'type', q: 'What is ' + nn + '/' + dd + ' of ' + m + '?', answer: String(m / dd * nn), check: 'value', explain: m + ' ÷ ' + dd + ' = ' + (m / dd) + ', then × ' + nn + ' = ' + (m / dd * nn) + '.' }; }
    return choice(r, 'In the fraction ' + n + '/' + d + ', what does the bottom number ' + d + ' tell you?', 'How many equal parts the whole is cut into', ['How many parts are shaded', 'How big the whole is', 'How many wholes there are'], 'The bottom number (denominator) is how many equal parts make one whole.');
  };
  FR[6] = function (r) { // equal fractions, simplifying
    var d = r.int(2, 9), n = r.int(1, d - 1), s = simp(n, d), k = r.int(0, 2), f = r.int(2, 5);
    n = s[0]; d = s[1];
    if (k === 0) return { type: 'type', q: 'Simplify ' + (n * f) + '/' + (d * f) + ' (write it in its simplest form)', answer: n + '/' + d, check: 'exact', explain: 'Divide top and bottom by ' + f + ': ' + n + '/' + d + '.' };
    if (k === 1) return choice(r, 'Which fraction is equal to ' + n + '/' + d + '?', (n * f) + '/' + (d * f), [(n * f) + '/' + (d * f + 1), (n + f) + '/' + (d + f), (n * f + 1) + '/' + (d * f), d + '/' + n], 'Multiply top and bottom by ' + f + ': ' + (n * f) + '/' + (d * f) + '.');
    return { type: 'type', q: n + '/' + d + ' = ?/' + (d * f), answer: String(n * f), check: 'value', explain: d + ' × ' + f + ' = ' + (d * f) + ', so the top is ' + n + ' × ' + f + ' = ' + (n * f) + '.' };
  };
  FR[7] = function (r) { // comparing
    var a = r.int(1, 9), b = r.int(2, 10), c = r.int(1, 9), d = r.int(2, 10);
    if (a >= b) a = b - 1; if (c >= d) c = d - 1;
    if (r() < 0.25) { c = a * 2; d = b * 2; }
    var x = a / b, y = c / d, sign = Math.abs(x - y) < 1e-9 ? '=' : x > y ? '>' : '<';
    if (r() < 0.6) return choice(r, 'Which sign goes in the gap?  ' + a + '/' + b + ' ☐ ' + c + '/' + d, sign, ['<', '>', '='], 'Make the bottoms the same: ' + (a * d) + '/' + (b * d) + ' and ' + (c * b) + '/' + (b * d) + '.');
    var list = r.shuffle([[a, b], [c, d], [r.int(1, 3), r.int(4, 8)]]).filter(function (f, i, all) { return all.findIndex(function (g) { return Math.abs(g[0] / g[1] - f[0] / f[1]) < 1e-9; }) === i; });
    var biggest = list.slice().sort(function (p, q) { return q[0] / q[1] - p[0] / p[1]; })[0];
    return choice(r, 'Which fraction is the biggest?', biggest[0] + '/' + biggest[1], list.map(function (f) { return f[0] + '/' + f[1]; }), biggest[0] + '/' + biggest[1] + ' is the biggest: ' + (biggest[0] / biggest[1]).toFixed(2) + ' as a decimal.');
  };
  FR[8] = function (r) { // add and subtract fractions
    var d1 = r.int(2, 8), d2 = r() < 0.5 ? d1 : r.int(2, 8), n1 = r.int(1, d1 - 1), n2 = r.int(1, d2 - 1), plus = r() < 0.6;
    if (!plus && n1 / d1 < n2 / d2) { var t = n1; n1 = n2; n2 = t; t = d1; d1 = d2; d2 = t; }
    var top = plus ? n1 * d2 + n2 * d1 : n1 * d2 - n2 * d1, bottom = d1 * d2, ans = fstr(top, bottom);
    return { type: 'type', q: n1 + '/' + d1 + ' ' + (plus ? '+' : '−') + ' ' + n2 + '/' + d2 + ' = ?', answer: ans, check: 'value',
      explain: (d1 === d2 ? 'Same bottoms: ' + n1 + ' ' + (plus ? '+' : '−') + ' ' + n2 + ' = ' + (plus ? n1 + n2 : n1 - n2) + ', so ' : 'Use the bottom ' + bottom + ': ' + (n1 * d2) + '/' + bottom + ' ' + (plus ? '+' : '−') + ' ' + (n2 * d1) + '/' + bottom + ' = ') + ans + '.' };
  };
  FR[9] = function (r) { // multiply and divide fractions
    var n1 = r.int(1, 7), d1 = r.int(2, 9), n2 = r.int(1, 7), d2 = r.int(2, 9), times = r() < 0.55;
    if (times) return { type: 'type', q: n1 + '/' + d1 + ' × ' + n2 + '/' + d2 + ' = ?', answer: fstr(n1 * n2, d1 * d2), check: 'value', explain: 'Top × top and bottom × bottom: ' + (n1 * n2) + '/' + (d1 * d2) + (fstr(n1 * n2, d1 * d2) !== (n1 * n2) + '/' + (d1 * d2) ? ' = ' + fstr(n1 * n2, d1 * d2) : '') + '.' };
    return { type: 'type', q: n1 + '/' + d1 + ' ÷ ' + n2 + '/' + d2 + ' = ?', answer: fstr(n1 * d2, d1 * n2), check: 'value', explain: 'Flip the second fraction and multiply: ' + n1 + '/' + d1 + ' × ' + d2 + '/' + n2 + ' = ' + fstr(n1 * d2, d1 * n2) + '.' };
  };
  FR[10] = function (r) { // mixed numbers, decimals, percent
    var k = r.int(0, 3);
    if (k === 0) { var d = r.int(2, 9), w = r.int(1, 4), n = r.int(1, d - 1), s = simp(n, d); n = s[0]; d = s[1]; var top = w * d + n; return { type: 'type', q: 'Write ' + top + '/' + d + ' as a mixed number (like 2 1/3)', answer: w + ' ' + n + '/' + d, check: 'exact', explain: top + ' ÷ ' + d + ' = ' + w + ' remainder ' + n + ', so ' + w + ' ' + n + '/' + d + '.' }; }
    var f = r.pick([[1, 2], [1, 4], [3, 4], [1, 5], [2, 5], [3, 5], [4, 5], [1, 10], [3, 10], [7, 10], [1, 20], [1, 8], [3, 8]]);
    var dec = f[0] / f[1];
    if (k === 1) return { type: 'type', q: 'Write ' + f[0] + '/' + f[1] + ' as a decimal', answer: String(dec), check: 'value', explain: f[0] + ' ÷ ' + f[1] + ' = ' + dec + '.' };
    if (k === 2) return { type: 'type', q: 'Write ' + f[0] + '/' + f[1] + ' as a percent', answer: (dec * 100) + '%', check: 'percent', explain: f[0] + '/' + f[1] + ' = ' + dec + ' = ' + (dec * 100) + '%.' };
    var pct = r.pick([10, 20, 25, 50, 75]), of = r.int(2, 20) * 4;
    return choice(r, 'What is ' + pct + '% of ' + of + '?', of * pct / 100, [of * pct / 100 + 1, of - of * pct / 100 + 2, of / pct, pct], pct + '% means ' + pct + '/100: ' + of + ' × ' + pct + '/100 = ' + (of * pct / 100) + '.');
  };

  // ---------------------------------------------------------------- English
  var WORDS = [['🍎', 'apple'], ['🐶', 'dog'], ['🐱', 'cat'], ['🏠', 'house'], ['🚗', 'car'], ['📚', 'book'], ['☀️', 'sun'], ['🌙', 'moon'], ['🌳', 'tree'], ['🐟', 'fish'],
    ['🍌', 'banana'], ['⚽', 'ball'], ['🚲', 'bicycle'], ['✏️', 'pencil'], ['🐦', 'bird'], ['🌧️', 'rain'], ['🍞', 'bread'], ['🥛', 'milk'], ['👟', 'shoe'], ['🕐', 'clock'],
    ['🐘', 'elephant'], ['🍕', 'pizza'], ['🎂', 'cake'], ['🚌', 'bus'], ['🌸', 'flower'], ['⭐', 'star'], ['🐄', 'cow'], ['🦁', 'lion'], ['🍊', 'orange'], ['🔑', 'key'],
    ['🎒', 'bag'], ['🪑', 'chair'], ['🛏️', 'bed'], ['🚪', 'door'], ['🪟', 'window'], ['🧢', 'hat'], ['🐔', 'chicken'], ['🍚', 'rice'], ['🥚', 'egg'], ['💧', 'water']];
  var SENTENCES = [
    ['The cat ___ on the mat.', 'sits', ['sit', 'sitting', 'are sit']], ['I ___ my teeth every morning.', 'brush', ['brushes', 'brushing', 'brushed to']],
    ['She ___ to school by bus.', 'goes', ['go', 'going', 'gone']], ['We ___ football after school.', 'play', ['plays', 'playing', 'is play']],
    ['My brother ___ very tall.', 'is', ['are', 'am', 'be']], ['They ___ happy today.', 'are', ['is', 'am', 'be']], ['I ___ hungry.', 'am', ['is', 'are', 'be']],
    ['Look! It ___ raining.', 'is', ['are', 'am', 'be']], ['He ___ a red bike.', 'has', ['have', 'having', 'haves']], ['Birds can ___.', 'fly', ['flies', 'flying', 'flew to']],
    ['Please ___ the door.', 'close', ['closes', 'closing', 'closed to']], ['The sun ___ in the east.', 'rises', ['rise', 'rising', 'rose up to']]];
  var ORDER = ['I like to read books', 'The dog is very happy', 'We go to school on Monday', 'My mother cooks rice every day', 'Can you help me please',
    'The birds sing in the morning', 'She has two little cats', 'It is cold and rainy today', 'He plays the guitar after dinner', 'Where is my blue pencil'];
  var PAST = [['go', 'went'], ['eat', 'ate'], ['see', 'saw'], ['run', 'ran'], ['play', 'played'], ['swim', 'swam'], ['write', 'wrote'], ['have', 'had'], ['make', 'made'], ['jump', 'jumped'],
    ['take', 'took'], ['come', 'came'], ['buy', 'bought'], ['sing', 'sang'], ['walk', 'walked'], ['drink', 'drank'], ['sleep', 'slept'], ['read', 'read'], ['find', 'found'], ['give', 'gave']];
  var PLURAL = [['child', 'children'], ['mouse', 'mice'], ['box', 'boxes'], ['baby', 'babies'], ['tooth', 'teeth'], ['foot', 'feet'], ['bus', 'buses'], ['leaf', 'leaves'], ['man', 'men'], ['city', 'cities'], ['dish', 'dishes'], ['knife', 'knives']];
  var AN = ['apple', 'egg', 'orange', 'umbrella', 'elephant', 'hour', 'island', 'ant', 'owl', 'ice cream'];
  var A = ['banana', 'dog', 'house', 'book', 'car', 'uniform', 'cat', 'pencil', 'table', 'horse'];
  var STORIES = [
    { text: 'Rina has a small garden. Every morning she waters her tomatoes and her flowers. One day she found a little green frog under a leaf. She named it Hopper and gave it a home in a pot of water.',
      qs: [['What does Rina do every morning?', 'She waters her plants', ['She feeds her cat', 'She goes swimming', 'She cooks breakfast']], ['What did she find under a leaf?', 'A frog', ['A snake', 'A bird', 'A key']], ['What is the frog\'s name?', 'Hopper', ['Froggy', 'Greenie', 'Rina']]] },
    { text: 'Tom wanted to build a kite. His grandfather helped him. They used paper, sticks and string. On Saturday the wind was strong, and the kite flew high above the trees. Tom was very proud.',
      qs: [['Who helped Tom?', 'His grandfather', ['His sister', 'His teacher', 'His friend Rina']], ['What did they NOT use?', 'Glass', ['Paper', 'Sticks', 'String']], ['How did Tom feel?', 'Proud', ['Sad', 'Angry', 'Scared']]] },
    { text: 'The school had a sports day. Ayu ran the 100 metres race. She was not the fastest at the start, but she never stopped trying. At the end she came second and got a silver medal.',
      qs: [['What race did Ayu run?', 'The 100 metres', ['The long jump', 'Swimming', 'The marathon']], ['What place did she come?', 'Second', ['First', 'Third', 'Last']], ['What did she get?', 'A silver medal', ['A gold cup', 'A book', 'Nothing']]] },
    { text: 'It was raining, so Max and his little sister stayed inside. They built a castle with blankets and chairs. Inside the castle they read stories with a torch until dinner was ready.',
      qs: [['Why did they stay inside?', 'It was raining', ['It was too hot', 'They were ill', 'It was night']], ['What did they build?', 'A castle of blankets', ['A sandcastle', 'A robot', 'A tree house']], ['What did they do inside it?', 'Read stories', ['Watched TV', 'Played football', 'Slept']]] },
    { text: 'Every year the town has a fruit market. Farmers bring mangoes, durians and bananas. Dimas likes mangoes best because they are sweet. His father prefers durian, but Dimas says it smells too strong.',
      qs: [['What fruit does Dimas like best?', 'Mangoes', ['Durians', 'Bananas', 'Apples']], ['Why does he like it?', 'It is sweet', ['It is big', 'It is cheap', 'It is green']], ['What does Dimas think of durian?', 'It smells too strong', ['It is his favourite', 'It is too small', 'It is too sour']]] }];
  var SPELL = [['because', ['becuase', 'becaus', 'beacause']], ['friend', ['freind', 'frend', 'friennd']], ['beautiful', ['beutiful', 'beautifull', 'beatiful']], ['school', ['scool', 'shcool', 'schol']],
    ['people', ['peaple', 'pepole', 'peopel']], ['different', ['diffrent', 'differant', 'diferent']], ['tomorrow', ['tommorow', 'tomorow', 'tommorrow']], ['answer', ['anser', 'answear', 'ansewr']],
    ['library', ['libary', 'liberary', 'librery']], ['Wednesday', ['Wensday', 'Wednsday', 'Wendesday']], ['science', ['sience', 'scince', 'sciense']], ['believe', ['beleive', 'belive', 'believ']]];

  var EN = {};
  EN[1] = function (r) { // words and pictures
    var w = r.pick(WORDS), others = r.shuffle(WORDS.filter(function (x) { return x !== w; })).slice(0, 3);
    if (r() < 0.6) return choice(r, 'What is this?', w[1], others.map(function (x) { return x[1]; }), 'It is a ' + w[1] + '.', '<div class="emoji-big">' + w[0] + '</div>');
    if (r() < 0.5) return { type: 'type', q: 'Write the word for this picture', answer: w[1], check: 'word', explain: 'It is spelled ' + w[1] + '.', pic: '<div class="emoji-big">' + w[0] + '</div>' };
    var opts = r.shuffle([w].concat(others));
    return { type: 'choice', q: 'Which picture is “' + w[1] + '”?', options: opts.map(function (x) { return x[0]; }), answer: opts.indexOf(w), explain: w[0] + ' is ' + w[1] + '.', bigOptions: true };
  };
  EN[2] = function (r) { // simple sentences
    if (r() < 0.6) { var s = r.pick(SENTENCES); return choice(r, 'Fill the gap: ' + s[0], s[1], s[2], s[0].replace('___', s[1])); }
    var sent = r.pick(ORDER), words = sent.split(' ');
    return { type: 'order', q: 'Put the words in the right order', words: r.shuffle(words), answer: sent, explain: sent + '.' };
  };
  EN[3] = function (r) { // grammar
    var k = r.int(0, 3);
    if (k === 0) { var p = r.pick(PAST); return { type: 'type', q: 'Yesterday I ___ (' + p[0] + '). Write the past tense of “' + p[0] + '”.', answer: p[1], check: 'word', explain: 'The past of ' + p[0] + ' is ' + p[1] + '.' }; }
    if (k === 1) { var pl = r.pick(PLURAL); return choice(r, 'One ' + pl[0] + ', two …', pl[1], [pl[0] + 's', pl[0] + 'es', pl[1] + 's'], 'The plural of ' + pl[0] + ' is ' + pl[1] + '.'); }
    if (k === 2) { var an = r() < 0.5, word = r.pick(an ? AN : A); return choice(r, 'I have ___ ' + word + '.', an ? 'an' : 'a', [an ? 'a' : 'an', 'the a', 'some'], an ? 'Use “an” before a vowel sound: an ' + word + '.' : 'Use “a” before a consonant sound: a ' + word + '.'); }
    var subj = r.pick([['I', 'am'], ['You', 'are'], ['He', 'is'], ['She', 'is'], ['We', 'are'], ['They', 'are'], ['It', 'is']]);
    return choice(r, subj[0] + ' ___ ready for the test.', subj[1], ['am', 'is', 'are'].filter(function (x) { return x !== subj[1]; }), subj[0] + ' ' + subj[1] + ' ready.');
  };
  EN[4] = function (r, i, ctx) { // reading
    var story = ctx.story || (ctx.story = r.pick(STORIES));
    ctx.read = (ctx.read || 0) + 1;
    if (ctx.read > story.qs.length) return EN[r.int(2, 3)](r); // after the story: sentence and grammar practice
    var q = story.qs[ctx.read - 1];
    var c = choice(r, q[0], q[1], q[2], 'The story says so: look again!');
    c.story = story.text;
    return c;
  };
  EN[5] = function (r) { // spelling and writing
    var k = r.int(0, 2);
    if (k === 0) { var sp = r.pick(SPELL); return choice(r, 'Which word is spelled correctly?', sp[0], sp[1], 'The right spelling is “' + sp[0] + '”.'); }
    if (k === 1) {
      var w = r.pick(WORDS.filter(function (x) { return x[1].length >= 4 && x[1].indexOf(' ') < 0; }))[1], mixed = w;
      for (var tries = 0; mixed === w && tries < 10; tries++) mixed = r.shuffle(w.split('')).join('');
      return { type: 'type', q: 'Unscramble the letters: ' + mixed.toUpperCase().split('').join(' '), answer: w, check: 'word', explain: 'The word is ' + w + '.' };
    }
    var sent = r.pick(ORDER);
    return { type: 'order', q: 'Make a sentence', words: r.shuffle(sent.split(' ')), answer: sent, explain: sent + '.' };
  };

  var COURSES = {
    fractions: {
      name: 'Fractions', icon: '🍕', subject: 'Maths',
      levels: ['Numbers and counting', 'Adding and taking away', 'Times tables', 'Dividing', 'What a fraction is', 'Equal fractions and simplifying', 'Comparing fractions',
        'Adding and subtracting fractions', 'Multiplying and dividing fractions', 'Mixed numbers, decimals and percent'],
      make: FR
    },
    english: {
      name: 'English', icon: '🇬🇧', subject: 'Language',
      levels: ['Words and pictures', 'Simple sentences', 'Grammar', 'Reading stories', 'Spelling and writing'],
      make: EN
    }
  };

  // A worksheet: 10 questions, most from this level, some from earlier levels, and old mistakes to try again.
  function worksheet(courseId, level, seed, mistakes) {
    var c = COURSES[courseId], r = rng(courseId + '|' + level + '|' + seed), out = [], seen = {}, ctx = {};
    var total = 10, review = level > 1 ? 2 : 0;
    (mistakes || []).slice(0, 2).forEach(function (m) { if (m && m.q) { out.push(m); seen[m.q + (m.story || '')] = 1; } });
    for (var tries = 0; out.length < total && tries < 200; tries++) {
      var lv = out.length < total - review ? level : r.int(1, level - 1);
      var q = c.make[lv](r, out.length, ctx);
      var key = q.q + (q.pic || '') + (q.words ? q.words.join() : '') + (q.story ? q.story.slice(0, 20) : '');
      if (seen[key]) continue;
      seen[key] = 1;
      q.level = lv;
      out.push(q);
    }
    // reading questions stay together after the story
    return out;
  }

  window.WSCourses = { list: COURSES, worksheet: worksheet, rng: rng, check: check };
})();
