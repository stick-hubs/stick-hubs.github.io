// Stick Hubs server: a Cloudflare Worker that runs
//   1. Stick Lab Duo (talks to Claude Opus 5.5), at POST /chat
//   2. the Game Hub, where people publish Stick Lab projects, at /hub/...
//
// Secrets (set with `npx wrangler secret put NAME` or in the Cloudflare dashboard):
//   ANTHROPIC_API_KEY  your Anthropic API key (never put it in the website's code)
//   OWNER_PASS         a long secret phrase; a device that sends it has no Duo limit and can remove any project
// Variables (wrangler.toml [vars]):
//   DAILY_LIMIT          Duo messages per person per day for everyone else (default 10)
//   GLOBAL_DAILY_LIMIT   Duo messages per day for everyone together, so the bill can't run away (default 200)
//   PUBLISH_DAILY_LIMIT  projects one person can publish or update per day (default 5)
//   SITE_URL             the website (default https://stick-hubs.github.io)
// Accounts (sign in with GitHub) need a GitHub OAuth App:
//   GITHUB_CLIENT_ID     (variable) the app's Client ID
//   GITHUB_CLIENT_SECRET (secret)   the app's client secret
// KV namespace binding:
//   DUO_KV               stores Duo message counts, Game Hub projects and accounts
// D1 database binding (for friends and chat):
//   SH_DB                friend lists, chat messages, reports and the Swiss search index (tables are made automatically)
// Cron Trigger (for the Swiss search robot): */2 * * * *
// AI                   Workers AI (free daily allowance), used by WorkSheet++ for courses people write themselves

const MODEL = 'claude-opus-5-5';
const MAX_TOKENS = 4096;
const MAX_MESSAGES = 40;
const MAX_CHARS = 60000;

const MAX_FILE = 10 * 1024 * 1024; // a published .sl file can be up to 10 MB
const MAX_THUMB = 300 * 1024;
const MAX_INDEX = 1000; // projects kept in the Game Hub list
const HIDE_AFTER_REPORTS = 3;

const ALLOWED_ORIGINS = [
    'https://stick-hubs.github.io',
    'https://app.stick-lab.local', // the Stick Lab desktop app
    'http://localhost:8765'
];

const corsHeaders = origin => ({
    'Access-Control-Allow-Origin': ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0],
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'content-type, x-duo-owner, authorization',
    'Access-Control-Expose-Headers': 'x-duo-remaining, x-duo-limit',
    'Vary': 'Origin'
});

const json = (status, body, headers) => new Response(JSON.stringify(body), {
    status,
    headers: {'content-type': 'application/json', ...headers}
});

// Constant-time comparison so secrets can't be guessed by timing.
const sameSecret = (a, b) => {
    if (typeof a !== 'string' || typeof b !== 'string' || !b) return false;
    let diff = a.length ^ b.length;
    for (let i = 0; i < Math.max(a.length, b.length); i++) {
        diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
    }
    return diff === 0;
};

const isOwner = (request, env) => sameSecret(request.headers.get('x-duo-owner') || '', env.OWNER_PASS || '');

const today = () => new Date().toISOString().slice(0, 10);
const clientIp = request => request.headers.get('CF-Connecting-IP') || 'unknown';

// ---------------------------------------------------------------- Duo

const validMessages = messages => Array.isArray(messages) && messages.length > 0 &&
    messages.length <= MAX_MESSAGES &&
    messages.every(m => (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string') &&
    messages[messages.length - 1].role === 'user' &&
    messages.reduce((n, m) => n + m.content.length, 0) <= MAX_CHARS;

const handleChat = async (request, env, cors) => {
    if (!env.ANTHROPIC_API_KEY) {
        return json(500, {error: 'The Duo server has no API key yet.'}, cors);
    }
    let body;
    try {
        body = await request.json();
    } catch (e) {
        return json(400, {error: 'Bad request'}, cors);
    }
    if (!validMessages(body.messages)) {
        return json(400, {error: 'That conversation is too long. Start a new chat.'}, cors);
    }

    // Daily limits, unless this is the owner's device:
    // each person gets DAILY_LIMIT messages, and everyone together gets GLOBAL_DAILY_LIMIT.
    const owner = isOwner(request, env);
    const limit = Math.max(1, parseInt(env.DAILY_LIMIT || '10', 10));
    const globalLimit = Math.max(1, parseInt(env.GLOBAL_DAILY_LIMIT || '200', 10));
    let remaining = 'unlimited';
    if (!owner) {
        const day = today();
        const key = `count:${day}:${clientIp(request)}`;
        const globalKey = `total:${day}`;
        const [usedText, totalText] = await Promise.all([env.DUO_KV.get(key), env.DUO_KV.get(globalKey)]);
        const used = parseInt(usedText || '0', 10);
        const total = parseInt(totalText || '0', 10);
        if (used >= limit) {
            return json(429, {
                error: `You've used all ${limit} Duo messages for today. Come back tomorrow, ` +
                    'or add your own Anthropic API key in Duo settings.'
            }, {...cors, 'x-duo-remaining': '0', 'x-duo-limit': String(limit)});
        }
        if (total >= globalLimit) {
            return json(429, {
                error: 'Duo is resting: everyone together has used today\'s free messages. ' +
                    'Try again tomorrow, or add your own Anthropic API key in Duo settings.'
            }, {...cors, 'x-duo-remaining': '0', 'x-duo-limit': String(limit)});
        }
        const ttl = {expirationTtl: 60 * 60 * 30};
        // Counting is best effort: if the counter store is briefly busy, the message still goes through.
        await Promise.all([
            env.DUO_KV.put(key, String(used + 1), ttl).catch(() => null),
            env.DUO_KV.put(globalKey, String(total + 1), ttl).catch(() => null)
        ]);
        remaining = String(Math.min(limit - used - 1, globalLimit - total - 1));
    }

    const upstream = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
            'content-type': 'application/json',
            'x-api-key': env.ANTHROPIC_API_KEY,
            'anthropic-version': '2023-06-01'
        },
        body: JSON.stringify({
            model: MODEL,
            max_tokens: MAX_TOKENS,
            system: typeof body.system === 'string' ? body.system.slice(0, 24000) : undefined,
            messages: body.messages,
            stream: true
        })
    });
    if (!upstream.ok) {
        const text = await upstream.text();
        let message = `Claude returned an error (${upstream.status}).`;
        try {
            message = JSON.parse(text).error.message || message;
        } catch (e) {
            // keep the generic message
        }
        return json(502, {error: message}, cors);
    }
    // Pass the stream of words straight through to Stick Lab.
    return new Response(upstream.body, {
        status: 200,
        headers: {
            ...cors,
            'content-type': 'text/event-stream',
            'cache-control': 'no-cache',
            'x-duo-remaining': remaining,
            'x-duo-limit': owner ? 'unlimited' : String(limit)
        }
    });
};

// ---------------------------------------------------------------- Game Hub
//
// KV keys:
//   hub:index        JSON list of every published project (newest first), with a hash of each edit key
//   hub:file:<id>    the .sl file
//   hub:thumb:<id>   the cover picture (JPEG or PNG)
//   hub:pub:<day>:<ip>     how many projects this person published today
//   hub:rep:<id>:<ip>      this person already reported this project

// Words that can't be used in titles, names or descriptions (the Game Hub is for kids).
const BLOCKED_WORDS = [
    'fuck', 'shit', 'bitch', 'cunt', 'dick', 'pussy', 'porn', 'sex', 'nude', 'naked', 'nigg', 'fag', 'retard',
    'rape', 'kill yourself', 'kys', 'nazi', 'hitler', 'whore', 'slut', 'asshole', 'bastard',
    'anjing', 'bangsat', 'kontol', 'memek', 'ngentot', 'babi', 'goblok', 'tolol', 'jancok', 'bajingan'
];

const cleanText = (value, max) => String(value || '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
const hasBlockedWord = text => {
    const plain = text.toLowerCase().replace(/[^a-z ]/g, '');
    const squashed = plain.replace(/ /g, '');
    return BLOCKED_WORDS.some(w => plain.includes(w) || squashed.includes(w.replace(/ /g, '')));
};

const randomId = length => {
    const bytes = crypto.getRandomValues(new Uint8Array(length));
    const chars = 'abcdefghijkmnopqrstuvwxyz23456789';
    return Array.from(bytes, b => chars[b % chars.length]).join('');
};

const sha256 = async text => {
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
    return Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, '0')).join('');
};

const readIndex = async env => {
    try {
        return JSON.parse(await env.DUO_KV.get('hub:index') || '[]');
    } catch (e) {
        return [];
    }
};
const writeIndex = (env, index) => env.DUO_KV.put('hub:index', JSON.stringify(index.slice(0, MAX_INDEX)));

// What everyone may see about a project (never the edit key hash).
const publicInfo = p => ({
    id: p.id, title: p.title, author: p.author, description: p.description,
    created: p.created, updated: p.updated, size: p.size, thumbType: p.thumbType,
    ownerLogin: p.ownerLogin || null
});

const isSlFile = bytes => {
    const magic = [0x53, 0x54, 0x49, 0x43, 0x4b, 0x4c, 0x41, 0x42]; // "STICKLAB"
    return bytes.length > 9 && magic.every((b, i) => bytes[i] === b);
};

const handlePublish = async (request, env, cors) => {
    let form;
    try {
        form = await request.formData();
    } catch (e) {
        return json(400, {error: 'Bad request'}, cors);
    }
    const title = cleanText(form.get('title'), 60);
    const author = cleanText(form.get('author'), 30);
    const description = cleanText(form.get('description'), 500);
    const file = form.get('file');
    const thumb = form.get('thumb');
    if (!title) return json(400, {error: 'Give your project a title.'}, cors);
    if (!author) return json(400, {error: 'Add a nickname.'}, cors);
    if (hasBlockedWord(`${title} ${author} ${description}`)) {
        return json(400, {error: 'Please change the title, nickname or description: they have a word that isn\'t allowed on the Game Hub.'}, cors);
    }
    if (!file || typeof file.arrayBuffer !== 'function') return json(400, {error: 'The project file is missing.'}, cors);
    if (file.size > MAX_FILE) return json(413, {error: 'Projects can be up to 10 MB. Try making the pictures or sounds smaller.'}, cors);
    const bytes = new Uint8Array(await file.arrayBuffer());
    if (!isSlFile(bytes)) return json(400, {error: 'Only Stick Lab .sl projects can be published.'}, cors);
    let thumbBytes = null;
    let thumbType = null;
    if (thumb && typeof thumb.arrayBuffer === 'function' && thumb.size > 0) {
        if (thumb.size > MAX_THUMB || !/^image\/(jpeg|png)$/.test(thumb.type)) {
            return json(400, {error: 'The cover picture must be a JPEG or PNG under 300 KB.'}, cors);
        }
        thumbBytes = await thumb.arrayBuffer();
        thumbType = thumb.type;
    }

    const owner = isOwner(request, env);
    const user = await sessionUser(request, env);
    if (!owner) {
        const limit = Math.max(1, parseInt(env.PUBLISH_DAILY_LIMIT || '5', 10));
        const key = `hub:pub:${today()}:${clientIp(request)}`;
        const used = parseInt(await env.DUO_KV.get(key) || '0', 10);
        if (used >= limit) {
            return json(429, {error: `You can publish ${limit} times a day. Try again tomorrow.`}, cors);
        }
        await env.DUO_KV.put(key, String(used + 1), {expirationTtl: 60 * 60 * 30}).catch(() => null);
    }

    const index = await readIndex(env);
    const now = new Date().toISOString();
    const updateId = cleanText(form.get('id'), 20);
    let entry;
    let editKey = null;
    if (updateId) {
        entry = index.find(p => p.id === updateId);
        if (!entry) return json(404, {error: 'That project is no longer on the Game Hub. Publish it as a new project.'}, cors);
        const given = cleanText(form.get('editKey'), 100);
        const isAuthor = (user && entry.ownerId === user.id) || sameSecret(await sha256(given), entry.keyHash);
        if (!owner && !isAuthor) {
            return json(403, {error: 'Only the device that published this project can update it.'}, cors);
        }
        Object.assign(entry, {title, author, description, updated: now, size: bytes.length});
        if (thumbType) entry.thumbType = thumbType;
        index.splice(index.indexOf(entry), 1);
    } else {
        editKey = randomId(24);
        entry = {
            id: randomId(8), title, author, description, created: now, updated: now,
            size: bytes.length, thumbType, keyHash: await sha256(editKey), reports: 0, hidden: false
        };
    }
    if (user && !entry.ownerId) {
        entry.ownerId = user.id;
        entry.ownerLogin = user.login;
    }
    await env.DUO_KV.put(`hub:file:${entry.id}`, bytes);
    if (thumbBytes) await env.DUO_KV.put(`hub:thumb:${entry.id}`, thumbBytes);
    index.unshift(entry);
    await writeIndex(env, index);
    return json(200, {ok: true, id: entry.id, editKey, project: publicInfo(entry)}, cors);
};

const handleList = async (env, cors) => {
    const index = await readIndex(env);
    return json(200, {projects: index.filter(p => !p.hidden).map(publicInfo)},
        {...cors, 'cache-control': 'public, max-age=30'});
};

const handleInfo = async (env, cors, id) => {
    const entry = (await readIndex(env)).find(p => p.id === id && !p.hidden);
    if (!entry) return json(404, {error: 'This project isn\'t on the Game Hub.'}, cors);
    return json(200, {project: publicInfo(entry)}, cors);
};

const handleFile = async (env, cors, id, kind) => {
    const entry = (await readIndex(env)).find(p => p.id === id && !p.hidden);
    if (!entry) return json(404, {error: 'This project isn\'t on the Game Hub.'}, cors);
    const data = await env.DUO_KV.get(`hub:${kind}:${id}`, 'arrayBuffer');
    if (!data) return json(404, {error: 'Not found'}, cors);
    return new Response(data, {
        headers: {
            ...cors,
            'content-type': kind === 'thumb' ? (entry.thumbType || 'image/jpeg') : 'application/x-stick-lab',
            'cache-control': 'public, max-age=60'
        }
    });
};

const handleReport = async (request, env, cors) => {
    let body;
    try {
        body = await request.json();
    } catch (e) {
        return json(400, {error: 'Bad request'}, cors);
    }
    const id = cleanText(body.id, 20);
    const index = await readIndex(env);
    const entry = index.find(p => p.id === id);
    if (!entry) return json(404, {error: 'Not found'}, cors);
    const seenKey = `hub:rep:${id}:${clientIp(request)}`;
    if (await env.DUO_KV.get(seenKey)) return json(200, {ok: true}, cors);
    await env.DUO_KV.put(seenKey, '1', {expirationTtl: 60 * 60 * 24 * 60});
    entry.reports = (entry.reports || 0) + 1;
    if (entry.reports >= HIDE_AFTER_REPORTS) entry.hidden = true;
    await writeIndex(env, index);
    return json(200, {ok: true}, cors);
};

// The author (with the edit key saved on their device) or the owner can remove a project.
const handleDelete = async (request, env, cors) => {
    let body;
    try {
        body = await request.json();
    } catch (e) {
        return json(400, {error: 'Bad request'}, cors);
    }
    const id = cleanText(body.id, 20);
    const index = await readIndex(env);
    const entry = index.find(p => p.id === id);
    if (!entry) return json(404, {error: 'Not found'}, cors);
    const user = await sessionUser(request, env);
    const allowed = isOwner(request, env) || (user && entry.ownerId === user.id) ||
        sameSecret(await sha256(cleanText(body.editKey, 100)), entry.keyHash);
    if (!allowed) return json(403, {error: 'Only the person who published this project can remove it.'}, cors);
    index.splice(index.indexOf(entry), 1);
    await writeIndex(env, index);
    await Promise.all([env.DUO_KV.delete(`hub:file:${id}`), env.DUO_KV.delete(`hub:thumb:${id}`)]);
    return json(200, {ok: true}, cors);
};


// ---------------------------------------------------------------- Accounts (sign in with GitHub)
//
// KV keys:
//   user:<githubId>      the profile (JSON)
//   login:<login>        githubId for a GitHub username (lower case)
//   sess:<token-hash>    githubId for a signed-in device (expires after 30 days)
//   img:<kind>:<id>      profile picture or banner image
//   urep:<id>:<ip>       this person already reported this profile

const SESSION_DAYS = 30;
const MAX_AVATAR = 300 * 1024;
const MAX_BANNER = 600 * 1024;
const ACCENTS = ['#2a6ab8', '#2f9a2a', '#e53935', '#fb8c00', '#8e24aa', '#00897b', '#f6b93b', '#455a64'];
const BANNERS = ['sky', 'sunset', 'night', 'forest', 'lava', 'ocean'];
const FAVORITES = ['', 'Stick Legions II', 'Battle Chess', 'Sort It!', 'Age of War Mobile', 'Stick Lab'];

const siteUrl = env => (env.SITE_URL || 'https://stick-hubs.github.io').replace(/\/$/, '');

const hmac = async (secret, text) => {
    const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), {name: 'HMAC', hash: 'SHA-256'}, false, ['sign']);
    const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(text));
    return Array.from(new Uint8Array(sig), b => b.toString(16).padStart(2, '0')).join('');
};

const sessionUser = async (request, env) => {
    const auth = request.headers.get('authorization') || '';
    const m = /^Bearer ([a-z0-9]{20,80})$/i.exec(auth);
    if (!m) return null;
    const id = await env.DUO_KV.get(`sess:${await sha256(m[1])}`);
    if (!id) return null;
    try {
        return JSON.parse(await env.DUO_KV.get(`user:${id}`) || 'null');
    } catch (e) {
        return null;
    }
};

const imageUrl = (base, kind, user) => (user[`${kind}Version`] ? `${base}/img/${kind}/${user.id}?v=${user[`${kind}Version`]}` : null);

// What everyone may see about an account.
const publicProfile = (user, base) => ({
    login: user.login,
    displayName: user.displayName || user.login,
    bio: user.bio || '',
    accent: user.accent || ACCENTS[0],
    bannerPreset: user.bannerPreset || 'sky',
    favorite: user.favorite || '',
    joined: user.created,
    avatar: imageUrl(base, 'avatar', user) || user.githubAvatar || null,
    banner: imageUrl(base, 'banner', user)
});

// Where to go back to after signing in: only the Stick Hubs website or a test copy of it.
const safeReturn = (value, env) => {
    try {
        const url = new URL(value);
        if (ALLOWED_ORIGINS.includes(url.origin) || url.origin === new URL(siteUrl(env)).origin) return url.href.split('#')[0];
    } catch (e) {
        // fall through
    }
    return `${siteUrl(env)}/account.html`;
};

const handleLogin = async (request, env, url) => {
    if (!env.GITHUB_CLIENT_ID || !env.GITHUB_CLIENT_SECRET) {
        return new Response('Accounts are not switched on yet.', {status: 503});
    }
    const back = safeReturn(url.searchParams.get('return') || '', env);
    const payload = `${Date.now()}|${back}`;
    const state = `${btoa(payload).replace(/=+$/, '')}.${await hmac(env.GITHUB_CLIENT_SECRET, payload)}`;
    const target = new URL('https://github.com/login/oauth/authorize');
    target.searchParams.set('client_id', env.GITHUB_CLIENT_ID);
    target.searchParams.set('redirect_uri', `${url.origin}/auth/callback`);
    target.searchParams.set('state', state);
    target.searchParams.set('allow_signup', 'true');
    return Response.redirect(target.href, 302);
};

const handleCallback = async (request, env, url) => {
    const fail = (back, why) => Response.redirect(`${back}#signin-error=${encodeURIComponent(why)}`, 302);
    const [encoded, sig] = (url.searchParams.get('state') || '').split('.');
    let payload = '';
    try {
        payload = atob(encoded || '');
    } catch (e) {
        payload = '';
    }
    const [time, back] = [payload.slice(0, payload.indexOf('|')), payload.slice(payload.indexOf('|') + 1)];
    const home = `${siteUrl(env)}/account.html`;
    if (!payload || !sig || !sameSecret(sig, await hmac(env.GITHUB_CLIENT_SECRET || '', payload))) return fail(home, 'Sign-in link is broken. Try again.');
    const goBack = safeReturn(back, env);
    if (Date.now() - parseInt(time, 10) > 15 * 60 * 1000) return fail(goBack, 'Sign-in took too long. Try again.');
    const code = url.searchParams.get('code');
    if (!code) return fail(goBack, 'Sign-in was cancelled.');

    const tokenResponse = await fetch('https://github.com/login/oauth/access_token', {
        method: 'POST',
        headers: {'content-type': 'application/json', 'accept': 'application/json'},
        body: JSON.stringify({client_id: env.GITHUB_CLIENT_ID, client_secret: env.GITHUB_CLIENT_SECRET, code,
            redirect_uri: `${url.origin}/auth/callback`})
    });
    const tokenBody = await tokenResponse.json().catch(() => ({}));
    if (!tokenBody.access_token) return fail(goBack, 'GitHub did not sign you in. Try again.');
    const ghResponse = await fetch('https://api.github.com/user', {
        headers: {'authorization': `Bearer ${tokenBody.access_token}`, 'accept': 'application/vnd.github+json', 'user-agent': 'stick-hubs'}
    });
    const gh = await ghResponse.json().catch(() => ({}));
    if (!gh.id || !gh.login) return fail(goBack, 'Could not read your GitHub account.');

    const id = String(gh.id);
    let user = null;
    try {
        user = JSON.parse(await env.DUO_KV.get(`user:${id}`) || 'null');
    } catch (e) {
        user = null;
    }
    const now = new Date().toISOString();
    if (!user) {
        user = {id, login: gh.login, displayName: cleanText(gh.login, 30), bio: '', accent: ACCENTS[0], bannerPreset: 'sky',
            favorite: '', created: now};
    }
    if (user.login !== gh.login) {
        await env.DUO_KV.delete(`login:${user.login.toLowerCase()}`).catch(() => null);
        user.login = gh.login;
    }
    user.githubAvatar = typeof gh.avatar_url === 'string' ? gh.avatar_url : null;
    user.lastSeen = now;
    const token = randomId(40);
    await Promise.all([
        env.DUO_KV.put(`user:${id}`, JSON.stringify(user)),
        env.DUO_KV.put(`login:${gh.login.toLowerCase()}`, id),
        env.DUO_KV.put(`sess:${await sha256(token)}`, id, {expirationTtl: SESSION_DAYS * 24 * 60 * 60})
    ]);
    return Response.redirect(`${goBack}#session=${token}`, 302);
};

const handleLogout = async (request, env, cors) => {
    const m = /^Bearer ([a-z0-9]{20,80})$/i.exec(request.headers.get('authorization') || '');
    if (m) await env.DUO_KV.delete(`sess:${await sha256(m[1])}`);
    return json(200, {ok: true}, cors);
};

const handleMe = async (request, env, cors, base) => {
    const user = await sessionUser(request, env);
    if (!user) return json(401, {error: 'Please sign in again.'}, cors);
    if (request.method === 'GET') return json(200, {profile: publicProfile(user, base), id: user.id}, cors);
    let body;
    try {
        body = await request.json();
    } catch (e) {
        return json(400, {error: 'Bad request'}, cors);
    }
    const next = {...user};
    if ('displayName' in body) next.displayName = cleanText(body.displayName, 30) || user.login;
    if ('bio' in body) next.bio = String(body.bio || '').replace(/[\u0000-\u0009\u000b-\u001f\u007f]/g, '').slice(0, 300).trim();
    if ('accent' in body && ACCENTS.includes(body.accent)) next.accent = body.accent;
    if ('bannerPreset' in body && BANNERS.includes(body.bannerPreset)) next.bannerPreset = body.bannerPreset;
    if ('favorite' in body && FAVORITES.includes(body.favorite)) next.favorite = body.favorite;
    if (hasBlockedWord(`${next.displayName} ${next.bio}`)) {
        return json(400, {error: 'Your name or bio has a word that isn\'t allowed on Stick Hubs. Please change it.'}, cors);
    }
    next.updated = new Date().toISOString();
    await env.DUO_KV.put(`user:${user.id}`, JSON.stringify(next));
    return json(200, {profile: publicProfile(next, base)}, cors);
};

const isImage = (bytes, type) => {
    if (type === 'image/png') return bytes[0] === 0x89 && bytes[1] === 0x50;
    if (type === 'image/jpeg') return bytes[0] === 0xff && bytes[1] === 0xd8;
    if (type === 'image/webp') return bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50;
    return false;
};

const handleMeImage = async (request, env, cors, base, kind) => {
    const user = await sessionUser(request, env);
    if (!user) return json(401, {error: 'Please sign in again.'}, cors);
    const type = (request.headers.get('content-type') || '').split(';')[0].trim();
    const bytes = new Uint8Array(await request.arrayBuffer());
    const next = {...user};
    if (bytes.length === 0) {
        // an empty upload removes the picture
        await env.DUO_KV.delete(`img:${kind}:${user.id}`);
        delete next[`${kind}Version`];
        delete next[`${kind}Type`];
    } else {
        const max = kind === 'avatar' ? MAX_AVATAR : MAX_BANNER;
        if (bytes.length > max || !isImage(bytes, type)) {
            return json(400, {error: `Pictures must be PNG, JPEG or WebP, under ${Math.round(max / 1024)} KB.`}, cors);
        }
        await env.DUO_KV.put(`img:${kind}:${user.id}`, bytes);
        next[`${kind}Version`] = Date.now().toString(36);
        next[`${kind}Type`] = type;
    }
    await env.DUO_KV.put(`user:${user.id}`, JSON.stringify(next));
    return json(200, {profile: publicProfile(next, base)}, cors);
};

const userByLogin = async (env, login) => {
    const id = await env.DUO_KV.get(`login:${String(login).toLowerCase()}`);
    if (!id) return null;
    try {
        return JSON.parse(await env.DUO_KV.get(`user:${id}`) || 'null');
    } catch (e) {
        return null;
    }
};

const handleProfile = async (env, cors, base, login) => {
    const user = await userByLogin(env, login);
    if (!user) return json(404, {error: 'There is no Stick Hubs account with that name.'}, cors);
    const projects = (await readIndex(env)).filter(p => p.ownerId === user.id && !p.hidden).map(publicInfo);
    return json(200, {profile: publicProfile(user, base), projects}, {...cors, 'cache-control': 'public, max-age=20'});
};

const handleImage = async (env, cors, kind, id) => {
    let user = null;
    try {
        user = JSON.parse(await env.DUO_KV.get(`user:${id}`) || 'null');
    } catch (e) {
        user = null;
    }
    const data = user && await env.DUO_KV.get(`img:${kind}:${id}`, 'arrayBuffer');
    if (!data) return json(404, {error: 'Not found'}, cors);
    return new Response(data, {headers: {...cors, 'content-type': user[`${kind}Type`] || 'image/png',
        'cache-control': 'public, max-age=86400'}});
};

// Reports: after 3 different people report a profile, its pictures and bio are removed.
// The owner (OWNER_PASS) resets a profile straight away.
const handleProfileReport = async (request, env, cors) => {
    let body;
    try {
        body = await request.json();
    } catch (e) {
        return json(400, {error: 'Bad request'}, cors);
    }
    const user = await userByLogin(env, cleanText(body.login, 60));
    if (!user) return json(404, {error: 'Not found'}, cors);
    const owner = isOwner(request, env);
    if (!owner) {
        const seenKey = `urep:${user.id}:${clientIp(request)}`;
        if (await env.DUO_KV.get(seenKey)) return json(200, {ok: true}, cors);
        await env.DUO_KV.put(seenKey, '1', {expirationTtl: 60 * 60 * 24 * 60});
        user.reports = (user.reports || 0) + 1;
    }
    if (owner || user.reports >= HIDE_AFTER_REPORTS) {
        await Promise.all([env.DUO_KV.delete(`img:avatar:${user.id}`), env.DUO_KV.delete(`img:banner:${user.id}`)]);
        ['avatarVersion', 'avatarType', 'bannerVersion', 'bannerType'].forEach(k => delete user[k]);
        user.bio = '';
        user.displayName = user.login;
        user.reports = 0;
    }
    await env.DUO_KV.put(`user:${user.id}`, JSON.stringify(user));
    return json(200, {ok: true, reset: owner}, cors);
};

// ---------------------------------------------------------------- friends and chat
// Stored in a D1 database (binding SH_DB) because KV only allows about 1,000 writes a day
// on the free plan. Only accepted friends can chat. Every message goes through a filter
// that hides swear words, phone numbers, emails, links and "add me on ..." apps, like Roblox.

const FRIEND_LIMIT = 200;
const MSG_MAX = 200;
const MSG_GAP_MS = 1200; // one message per 1.2 seconds
const MSG_DAILY = 500;
const REQUESTS_DAILY = 30;

let schemaReady = null;
const db = env => {
    if (!env.SH_DB) return null;
    if (!schemaReady) {
        schemaReady = env.SH_DB.batch([
            'CREATE TABLE IF NOT EXISTS friends (a TEXT NOT NULL, b TEXT NOT NULL, status TEXT NOT NULL, asker TEXT NOT NULL, created INTEGER NOT NULL, PRIMARY KEY (a, b))',
            'CREATE INDEX IF NOT EXISTS friends_b ON friends (b)',
            'CREATE TABLE IF NOT EXISTS blocks (who TEXT NOT NULL, blocked TEXT NOT NULL, created INTEGER NOT NULL, PRIMARY KEY (who, blocked))',
            'CREATE TABLE IF NOT EXISTS messages (id INTEGER PRIMARY KEY AUTOINCREMENT, a TEXT NOT NULL, b TEXT NOT NULL, sender TEXT NOT NULL, body TEXT NOT NULL, created INTEGER NOT NULL, unread INTEGER NOT NULL DEFAULT 1)',
            'CREATE INDEX IF NOT EXISTS messages_pair ON messages (a, b, id)',
            'CREATE INDEX IF NOT EXISTS messages_sender ON messages (sender, created)',
            'CREATE TABLE IF NOT EXISTS reports (id INTEGER PRIMARY KEY AUTOINCREMENT, reporter TEXT NOT NULL, target TEXT NOT NULL, message_id INTEGER, body TEXT, reason TEXT, created INTEGER NOT NULL)',
            'CREATE TABLE IF NOT EXISTS mutes (login TEXT PRIMARY KEY, until INTEGER NOT NULL)',
            'CREATE TABLE IF NOT EXISTS seen (login TEXT PRIMARY KEY, at INTEGER NOT NULL)'
        ].map(sql => env.SH_DB.prepare(sql))).catch(e => {
            schemaReady = null;
            throw e;
        });
    }
    return schemaReady.then(() => env.SH_DB);
};

const pair = (x, y) => (x < y ? [x, y] : [y, x]);
const lc = s => String(s || '').toLowerCase();

const BAD_WORDS = /\b(f+u+c+k\w*|sh[i1]t\w*|b[i1]tch\w*|cunt\w*|d[i1]ck\w*|puss(y|ies)|n[i1]gg\w*|fag\w*|slut\w*|wh[o0]re\w*|bastard\w*|asshole\w*|porn\w*|sex\w*|nude\w*|kontol\w*|anjing\w*|bangsat\w*|memek\w*|ngentot\w*|babi\b|goblok\w*|tolol\w*)/gi;
const OFF_SITE = /\b(discord|snap(chat)?|insta(gram)?|whats ?app|wa\.me|telegram|tele\b|tiktok|facebook|fb\b|line id|kik|skype|messenger|phone|hp\b|alamat|address)\b/gi;
const LINKS = /\b((https?:\/\/|www\.)\S+|\S+\.(com|net|org|io|gg|me|xyz|id|co|ly|app|link)\b\S*)/gi;
const EMAILS = /\S+@\S+\.\S+/g;
const NUMBERS = /(\+?\d[\d\s\-().]{5,}\d)/g; // phone numbers and other long numbers

// Hides anything unsafe with #### and says whether something was hidden.
const filterMessage = text => {
    let hidden = false;
    const hide = m => {
        hidden = true;
        return '#'.repeat(Math.max(4, Math.min(m.length, 12)));
    };
    let out = String(text).replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, MSG_MAX);
    out = out.replace(LINKS, m => (/^(https?:\/\/)?stick-hubs\.github\.io(\/|$)/i.test(m) ? m : hide(m)));
    out = out.replace(EMAILS, hide).replace(NUMBERS, hide).replace(BAD_WORDS, hide).replace(OFF_SITE, hide);
    return {text: out, hidden};
};

const friendCard = (user, base) => {
    const p = publicProfile(user, base);
    return {login: p.login, displayName: p.displayName, avatar: p.avatar, accent: p.accent};
};

const markSeen = async (d, login) => {
    // remember when someone was last on, at most once every 2 minutes (saves database writes)
    const row = await d.prepare('SELECT at FROM seen WHERE login = ?').bind(login).first();
    const now = Date.now();
    if (!row || now - row.at > 120000) await d.prepare('INSERT INTO seen (login, at) VALUES (?, ?) ON CONFLICT(login) DO UPDATE SET at = excluded.at').bind(login, now).run();
};

const needFriends = async (request, env, cors) => {
    const user = await sessionUser(request, env);
    if (!user) return {error: json(401, {error: 'Sign in with GitHub first.'}, cors)};
    const d = await db(env);
    if (!d) return {error: json(503, {error: 'Friends aren\'t switched on yet. The owner needs to add the SH_DB database.'}, cors)};
    return {user, me: lc(user.login), d};
};

const blockedEither = async (d, x, y) => !!(await d.prepare('SELECT 1 FROM blocks WHERE (who = ? AND blocked = ?) OR (who = ? AND blocked = ?)').bind(x, y, y, x).first());

const handleFriends = async (request, env, cors, base) => {
    const ctx = await needFriends(request, env, cors);
    if (ctx.error) return ctx.error;
    const {me, d} = ctx;
    await markSeen(d, me);
    const rows = (await d.prepare('SELECT a, b, status, asker FROM friends WHERE a = ? OR b = ? LIMIT 400').bind(me, me).all()).results || [];
    const unread = (await d.prepare('SELECT sender, COUNT(*) AS n FROM messages WHERE (a = ? OR b = ?) AND sender != ? AND unread = 1 GROUP BY sender').bind(me, me, me).all()).results || [];
    const unreadBy = Object.fromEntries(unread.map(r => [r.sender, r.n]));
    const blocked = ((await d.prepare('SELECT blocked FROM blocks WHERE who = ?').bind(me).all()).results || []).map(r => r.blocked);
    const others = rows.map(r => (r.a === me ? r.b : r.a));
    const seen = others.length ? (await d.prepare(`SELECT login, at FROM seen WHERE login IN (${others.map(() => '?').join(',')})`).bind(...others).all()).results || [] : [];
    const seenBy = Object.fromEntries(seen.map(r => [r.login, r.at]));
    const out = {friends: [], incoming: [], outgoing: [], blocked};
    for (const r of rows) {
        const other = r.a === me ? r.b : r.a;
        const u = await userByLogin(env, other);
        if (!u) continue;
        const card = friendCard(u, base);
        if (r.status === 'friends') {
            card.unread = unreadBy[other] || 0;
            card.online = !!seenBy[other] && Date.now() - seenBy[other] < 5 * 60000;
            out.friends.push(card);
        } else if (r.asker === me) {
            out.outgoing.push(card);
        } else {
            out.incoming.push(card);
        }
    }
    out.friends.sort((x, y) => (y.unread - x.unread) || (y.online - x.online) || x.displayName.localeCompare(y.displayName));
    return json(200, out, cors);
};

const handleFriendAction = async (request, env, cors, action) => {
    const ctx = await needFriends(request, env, cors);
    if (ctx.error) return ctx.error;
    const {me, d} = ctx;
    let body = {};
    try {
        body = await request.json();
    } catch (e) {
        // empty
    }
    const other = lc(body.login).replace(/^@/, '').trim();
    if (!/^[a-z0-9-]{1,39}$/.test(other)) return json(400, {error: 'Type a Stick Hubs username.'}, cors);
    if (other === me) return json(400, {error: 'You can\'t add yourself.'}, cors);
    const [a, b] = pair(me, other);
    const row = await d.prepare('SELECT status, asker FROM friends WHERE a = ? AND b = ?').bind(a, b).first();
    const now = Date.now();

    if (action === 'request') {
        const target = await userByLogin(env, other);
        if (!target) return json(404, {error: 'There is no Stick Hubs account called "' + other + '". They need to sign in to Stick Hubs once first.'}, cors);
        if (await blockedEither(d, me, other)) return json(403, {error: 'You can\'t add this person.'}, cors);
        if (row && row.status === 'friends') return json(200, {ok: true, status: 'friends'}, cors);
        if (row && row.asker !== me) { // they already asked me: just accept
            await d.prepare('UPDATE friends SET status = \'friends\' WHERE a = ? AND b = ?').bind(a, b).run();
            return json(200, {ok: true, status: 'friends'}, cors);
        }
        if (row) return json(200, {ok: true, status: 'sent'}, cors);
        const count = await d.prepare('SELECT COUNT(*) AS n FROM friends WHERE a = ? OR b = ?').bind(me, me).first();
        if (count.n >= FRIEND_LIMIT) return json(429, {error: `You can have up to ${FRIEND_LIMIT} friends and requests.`}, cors);
        const sentToday = await d.prepare('SELECT COUNT(*) AS n FROM friends WHERE asker = ? AND created > ?').bind(me, now - 86400000).first();
        if (sentToday.n >= REQUESTS_DAILY) return json(429, {error: 'You\'ve sent a lot of friend requests today. Try again tomorrow.'}, cors);
        await d.prepare('INSERT INTO friends (a, b, status, asker, created) VALUES (?, ?, \'pending\', ?, ?)').bind(a, b, me, now).run();
        return json(200, {ok: true, status: 'sent'}, cors);
    }
    if (action === 'accept') {
        if (!row || row.asker === me) return json(404, {error: 'That friend request isn\'t there any more.'}, cors);
        await d.prepare('UPDATE friends SET status = \'friends\' WHERE a = ? AND b = ?').bind(a, b).run();
        return json(200, {ok: true, status: 'friends'}, cors);
    }
    if (action === 'decline' || action === 'remove') {
        await d.prepare('DELETE FROM friends WHERE a = ? AND b = ?').bind(a, b).run();
        return json(200, {ok: true}, cors);
    }
    if (action === 'block') {
        await d.batch([
            d.prepare('DELETE FROM friends WHERE a = ? AND b = ?').bind(a, b),
            d.prepare('INSERT OR IGNORE INTO blocks (who, blocked, created) VALUES (?, ?, ?)').bind(me, other, now)
        ]);
        return json(200, {ok: true}, cors);
    }
    if (action === 'unblock') {
        await d.prepare('DELETE FROM blocks WHERE who = ? AND blocked = ?').bind(me, other).run();
        return json(200, {ok: true}, cors);
    }
    return json(404, {error: 'Not found'}, cors);
};

const areFriends = async (d, me, other) => {
    const [a, b] = pair(me, other);
    const row = await d.prepare('SELECT status FROM friends WHERE a = ? AND b = ?').bind(a, b).first();
    return !!row && row.status === 'friends';
};

const handleChatRead = async (request, env, cors, other, url) => {
    const ctx = await needFriends(request, env, cors);
    if (ctx.error) return ctx.error;
    const {me, d} = ctx;
    other = lc(other);
    if (!(await areFriends(d, me, other))) return json(403, {error: 'You can only chat with friends.'}, cors);
    const [a, b] = pair(me, other);
    const after = Math.max(0, parseInt(url.searchParams.get('after') || '0', 10) || 0);
    const rows = after ?
        (await d.prepare('SELECT id, sender, body, created FROM messages WHERE a = ? AND b = ? AND id > ? ORDER BY id LIMIT 100').bind(a, b, after).all()).results :
        ((await d.prepare('SELECT id, sender, body, created FROM messages WHERE a = ? AND b = ? ORDER BY id DESC LIMIT 60').bind(a, b).all()).results || []).reverse();
    if ((rows || []).some(r => r.sender === other)) {
        await d.prepare('UPDATE messages SET unread = 0 WHERE a = ? AND b = ? AND sender = ? AND unread = 1').bind(a, b, other).run();
    }
    await markSeen(d, me);
    const seen = await d.prepare('SELECT at FROM seen WHERE login = ?').bind(other).first();
    return json(200, {messages: rows || [], online: !!seen && Date.now() - seen.at < 5 * 60000}, cors);
};

const handleChatSend = async (request, env, cors) => {
    const ctx = await needFriends(request, env, cors);
    if (ctx.error) return ctx.error;
    const {me, d} = ctx;
    let body = {};
    try {
        body = await request.json();
    } catch (e) {
        // empty
    }
    const other = lc(body.to);
    if (!/^[a-z0-9-]{1,39}$/.test(other) || !(await areFriends(d, me, other))) return json(403, {error: 'You can only chat with friends.'}, cors);
    if (await blockedEither(d, me, other)) return json(403, {error: 'You can\'t message this person.'}, cors);
    const now = Date.now();
    const mute = await d.prepare('SELECT until FROM mutes WHERE login = ?').bind(me).first();
    if (mute && mute.until > now) return json(403, {error: 'Your chat is paused until ' + new Date(mute.until).toISOString().slice(0, 10) + ' because of reports.'}, cors);
    const last = await d.prepare('SELECT created FROM messages WHERE sender = ? ORDER BY created DESC LIMIT 1').bind(me).first();
    if (last && now - last.created < MSG_GAP_MS) return json(429, {error: 'Slow down a little!'}, cors);
    const todayCount = await d.prepare('SELECT COUNT(*) AS n FROM messages WHERE sender = ? AND created > ?').bind(me, now - 86400000).first();
    if (todayCount.n >= MSG_DAILY) return json(429, {error: 'You\'ve sent a lot of messages today. Try again tomorrow.'}, cors);
    const {text, hidden} = filterMessage(body.text || '');
    if (!text) return json(400, {error: 'Type a message first.'}, cors);
    const [a, b] = pair(me, other);
    const res = await d.prepare('INSERT INTO messages (a, b, sender, body, created) VALUES (?, ?, ?, ?, ?)').bind(a, b, me, text, now).run();
    return json(200, {message: {id: res.meta.last_row_id, sender: me, body: text, created: now}, hidden}, cors);
};

const handleUnread = async (request, env, cors) => {
    const ctx = await needFriends(request, env, cors);
    if (ctx.error) return ctx.error;
    const {me, d} = ctx;
    await markSeen(d, me);
    const msgs = await d.prepare('SELECT COUNT(*) AS n FROM messages WHERE (a = ? OR b = ?) AND sender != ? AND unread = 1').bind(me, me, me).first();
    const reqs = await d.prepare('SELECT COUNT(*) AS n FROM friends WHERE (a = ? OR b = ?) AND status = \'pending\' AND asker != ?').bind(me, me, me).first();
    return json(200, {messages: msgs.n, requests: reqs.n}, cors);
};

const handleChatReport = async (request, env, cors) => {
    const ctx = await needFriends(request, env, cors);
    if (ctx.error) return ctx.error;
    const {me, d} = ctx;
    let body = {};
    try {
        body = await request.json();
    } catch (e) {
        // empty
    }
    const msg = await d.prepare('SELECT id, a, b, sender, body FROM messages WHERE id = ?').bind(parseInt(body.id, 10) || 0).first();
    if (!msg || (msg.a !== me && msg.b !== me) || msg.sender === me) return json(404, {error: 'Message not found.'}, cors);
    const now = Date.now();
    await d.prepare('INSERT INTO reports (reporter, target, message_id, body, reason, created) VALUES (?, ?, ?, ?, ?, ?)')
        .bind(me, msg.sender, msg.id, msg.body, String(body.reason || '').slice(0, 200), now).run();
    // three different people reporting someone in a week pauses their chat for 3 days until the owner looks
    const reporters = await d.prepare('SELECT COUNT(DISTINCT reporter) AS n FROM reports WHERE target = ? AND created > ?').bind(msg.sender, now - (7 * 86400000)).first();
    if (reporters.n >= 3) {
        await d.prepare('INSERT INTO mutes (login, until) VALUES (?, ?) ON CONFLICT(login) DO UPDATE SET until = excluded.until').bind(msg.sender, now + (3 * 86400000)).run();
    }
    return json(200, {ok: true}, cors);
};

// The owner (OWNER_PASS) can read reports and pause or unpause someone's chat.
const handleOwnerReports = async (request, env, cors) => {
    if (!isOwner(request, env)) return json(403, {error: 'Owner password needed.'}, cors);
    const d = await db(env);
    if (!d) return json(503, {error: 'No SH_DB database.'}, cors);
    let body = {};
    try {
        body = await request.json();
    } catch (e) {
        // empty
    }
    if (body.mute) {
        const days = Math.max(0, Math.min(365, parseInt(body.days, 10) || 0));
        if (days) await d.prepare('INSERT INTO mutes (login, until) VALUES (?, ?) ON CONFLICT(login) DO UPDATE SET until = excluded.until').bind(lc(body.mute), Date.now() + (days * 86400000)).run();
        else await d.prepare('DELETE FROM mutes WHERE login = ?').bind(lc(body.mute)).run();
    }
    if (body.dismiss) await d.prepare('DELETE FROM reports WHERE id = ?').bind(parseInt(body.dismiss, 10) || 0).run();
    const reports = (await d.prepare('SELECT * FROM reports ORDER BY id DESC LIMIT 100').all()).results || [];
    const mutes = (await d.prepare('SELECT * FROM mutes WHERE until > ?').bind(Date.now()).all()).results || [];
    return json(200, {reports, mutes}, cors);
};

// ---------------------------------------------------------------- Swiss search engine
// Swiss has its own index. A small robot (SwissBot) runs every few minutes from a Cron Trigger,
// reads a few pages from a list of trusted, family-friendly websites, and saves their words in
// the same D1 database (binding SH_DB) with SQLite full-text search. It follows robots.txt,
// reads one page per website at a time, and never leaves the allowed websites, so kids don't
// land on bad pages. People can suggest a website; the owner approves it before SwissBot visits.

const SWISS_AGENT = 'SwissBot/1.0 (+https://stick-hubs.github.io/swiss-bot.html)';
const SWISS_PAGES_PER_RUN = 3;       // pages read every time the Cron Trigger runs
const SWISS_HOST_MAX = 4000;         // pages kept per website
const SWISS_LINKS_PER_PAGE = 25;     // new links saved from one page
const SWISS_TEXT_MAX = 6000;         // characters of text kept per page
const SWISS_HTML_MAX = 600 * 1024;   // bigger pages are cut off
const SWISS_REVISIT_DAYS = 30;
const SWISS_SUGGEST_DAILY = 20;      // website suggestions per person per day

// Where SwissBot starts. It only reads pages on these websites (and ones the owner approves).
const SWISS_SEEDS = [
    'https://stick-hubs.github.io/',
    'https://www.nasa.gov/', 'https://science.nasa.gov/', 'https://spaceplace.nasa.gov/',
    'https://www.weather.gov/', 'https://www.noaa.gov/', 'https://www.usgs.gov/',
    'https://www.nhs.uk/', 'https://www.cdc.gov/', 'https://medlineplus.gov/', 'https://www.who.int/',
    'https://www.gutenberg.org/', 'https://www.loc.gov/', 'https://www.si.edu/', 'https://www.smithsonianmag.com/',
    'https://www.bbc.co.uk/bitesize', 'https://www.bbcgoodfood.com/', 'https://www.bbc.com/news',
    'https://kids.nationalgeographic.com/', 'https://www.nationalgeographic.com/',
    'https://developer.mozilla.org/en-US/', 'https://www.w3schools.com/', 'https://docs.python.org/3/',
    'https://www.python.org/', 'https://scratch.mit.edu/', 'https://www.khanacademy.org/',
    'https://www.usa.gov/', 'https://www.gov.uk/', 'https://www.ready.gov/',
    'https://www.metoffice.gov.uk/', 'https://www.nps.gov/', 'https://www.britannica.com/',
    'https://www.howstuffworks.com/', 'https://www.wikihow.com/', 'https://www.ducksters.com/',
    'https://www.dkfindout.com/', 'https://www.coolmath.com/', 'https://www.mathsisfun.com/',
    'https://www.indonesia.go.id/', 'https://www.bmkg.go.id/', 'https://kemkes.go.id/',
    'https://www.un.org/', 'https://www.unicef.org/', 'https://www.worldwildlife.org/',
    'https://www.timeanddate.com/', 'https://www.rspb.org.uk/', 'https://www.nhm.ac.uk/'
];
const SWISS_SKIP_EXT = /\.(pdf|jpe?g|png|gif|webp|svg|ico|mp[34]|m4a|wav|ogg|webm|mov|avi|zip|gz|rar|7z|exe|dmg|msi|apk|iso|docx?|xlsx?|pptx?|csv|json|xml|rss|atom|css|js|woff2?|ttf)$/i;

let swissReady = null;
const swissDb = env => {
    if (!env.SH_DB) return null;
    if (!swissReady) {
        swissReady = env.SH_DB.batch([
            'CREATE TABLE IF NOT EXISTS swiss_urls (url TEXT PRIMARY KEY, host TEXT NOT NULL, depth INTEGER NOT NULL, status INTEGER NOT NULL DEFAULT 0, tries INTEGER NOT NULL DEFAULT 0, added INTEGER NOT NULL, visited INTEGER)',
            'CREATE INDEX IF NOT EXISTS swiss_urls_next ON swiss_urls (status, depth, added)',
            'CREATE INDEX IF NOT EXISTS swiss_urls_host ON swiss_urls (host, status)',
            'CREATE TABLE IF NOT EXISTS swiss_hosts (host TEXT PRIMARY KEY, allowed INTEGER NOT NULL DEFAULT 0, robots TEXT, robots_at INTEGER, pages INTEGER NOT NULL DEFAULT 0, last INTEGER NOT NULL DEFAULT 0)',
            'CREATE TABLE IF NOT EXISTS swiss_suggest (host TEXT PRIMARY KEY, url TEXT NOT NULL, created INTEGER NOT NULL)',
            'CREATE TABLE IF NOT EXISTS swiss_rate (k TEXT PRIMARY KEY, n INTEGER NOT NULL)',
            'CREATE VIRTUAL TABLE IF NOT EXISTS swiss_fts USING fts5(url UNINDEXED, title, description, body, host UNINDEXED, tokenize = "unicode61 remove_diacritics 2")'
        ].map(sql => env.SH_DB.prepare(sql))).catch(e => {
            swissReady = null;
            throw e;
        });
    }
    return swissReady.then(() => env.SH_DB);
};

const swissNormalize = (href, base) => {
    let u;
    try { u = new URL(href, base); } catch (e) { return null; }
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
    if (u.username || u.password || u.port) return null;
    u.hash = '';
    u.hostname = u.hostname.toLowerCase();
    for (const k of [...u.searchParams.keys()]) {
        if (/^(utm_|fbclid|gclid|ref$|ref_|share|mc_)/i.test(k)) u.searchParams.delete(k);
    }
    if ([...u.searchParams.keys()].length > 2) return null; // endless search and filter pages
    if (SWISS_SKIP_EXT.test(u.pathname)) return null;
    u.pathname = u.pathname.replace(/\/index\.(html?|php)$/i, '/');
    if (/\/(login|signin|sign-in|logout|register|cart|checkout|account|search)(\/|$)/i.test(u.pathname)) return null;
    const s = u.toString();
    return s.length > 400 ? null : s;
};

// robots.txt: the rules for "*" (or SwissBot), as [allow, path] pairs; the longest match wins.
const swissParseRobots = text => {
    const groups = [];
    let current = null, lastWasAgent = false;
    for (const raw of String(text).split(/\r?\n/)) {
        const line = raw.replace(/#.*/, '').trim();
        const m = /^([A-Za-z-]+)\s*:\s*(.*)$/.exec(line);
        if (!m) continue;
        const key = m[1].toLowerCase(), value = m[2].trim();
        if (key === 'user-agent') {
            if (!lastWasAgent) { current = {agents: [], rules: []}; groups.push(current); }
            current.agents.push(value.toLowerCase());
            lastWasAgent = true;
        } else {
            lastWasAgent = false;
            if (current && (key === 'allow' || key === 'disallow') && value) current.rules.push([key === 'allow', value]);
            if (current && key === 'disallow' && !value) current.rules.push([true, '/']);
        }
    }
    const mine = groups.filter(g => g.agents.some(a => a.startsWith('swissbot')));
    const pick = mine.length ? mine : groups.filter(g => g.agents.includes('*'));
    return pick.flatMap(g => g.rules);
};
const swissRobotsAllow = (rules, pathname) => {
    let best = null;
    for (const [allow, pattern] of rules) {
        const re = new RegExp('^' + pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\\\$$/, '$'));
        if (re.test(pathname) && (!best || pattern.length > best[1].length || (pattern.length === best[1].length && allow))) best = [allow, pattern];
    }
    return !best || best[0];
};

const swissSeedHosts = () => SWISS_SEEDS.map(s => new URL(s).hostname);

const swissHostAllowed = async (d, host) => {
    if (swissSeedHosts().includes(host)) return true;
    const row = await d.prepare('SELECT allowed FROM swiss_hosts WHERE host = ?').bind(host).first();
    return !!(row && row.allowed);
};

const swissQueue = async (d, urls, depth) => {
    const now = Date.now();
    const stmts = urls.map(u => d.prepare('INSERT OR IGNORE INTO swiss_urls (url, host, depth, added) VALUES (?, ?, ?, ?)').bind(u, new URL(u).hostname, depth, now));
    for (let i = 0; i < stmts.length; i += 50) await d.batch(stmts.slice(i, i + 50));
};

const swissRobots = async (d, host) => {
    const row = await d.prepare('SELECT robots, robots_at FROM swiss_hosts WHERE host = ?').bind(host).first();
    if (row && row.robots_at && Date.now() - row.robots_at < 7 * 864e5) return JSON.parse(row.robots || '[]');
    let rules = [];
    try {
        const r = await fetch(`https://${host}/robots.txt`, {headers: {'user-agent': SWISS_AGENT}, redirect: 'follow', cf: {cacheTtl: 86400}});
        if (r.ok) rules = swissParseRobots((await r.text()).slice(0, 200000));
        else if (r.status === 401 || r.status === 403) rules = [[false, '/']];
    } catch (e) { /* no robots.txt: everything allowed */ }
    await d.prepare('INSERT INTO swiss_hosts (host, robots, robots_at) VALUES (?, ?, ?) ON CONFLICT(host) DO UPDATE SET robots = excluded.robots, robots_at = excluded.robots_at')
        .bind(host, JSON.stringify(rules), Date.now()).run();
    return rules;
};

// Read one page with HTMLRewriter (fast and light): title, description, text and links.
const swissRead = async response => {
    const page = {title: '', description: '', text: '', links: [], noindex: false, nofollow: false, lang: ''};
    let skip = 0, inTitle = false, textLen = 0;
    const addText = t => {
        if (skip || textLen > SWISS_TEXT_MAX) return;
        page.text += t; textLen += t.length;
    };
    const rewriter = new HTMLRewriter()
        .on('html', {element: e => { page.lang = (e.getAttribute('lang') || '').slice(0, 5); }})
        .on('title', {element: e => { inTitle = true; e.onEndTag(() => { inTitle = false; }); }, text: t => { if (inTitle && page.title.length < 200) page.title += t.text; }})
        .on('meta', {element: e => {
            const name = (e.getAttribute('name') || e.getAttribute('property') || '').toLowerCase();
            const content = e.getAttribute('content') || '';
            if ((name === 'description' || name === 'og:description') && !page.description) page.description = content.slice(0, 300);
            if (name === 'robots' || name === 'swissbot') {
                if (/noindex|none/i.test(content)) page.noindex = true;
                if (/nofollow|none/i.test(content)) page.nofollow = true;
            }
        }})
        .on('script, style, noscript, svg, nav, footer, header, form, template, iframe', {element: e => { skip++; e.onEndTag(() => { skip--; }); }})
        .on('h1, h2, h3, p, li, td, blockquote, figcaption, dd, dt', {text: t => { addText(t.text); if (t.lastInTextNode) addText(' '); }})
        .on('a[href]', {element: e => {
            if (page.links.length < 300 && !/nofollow/i.test(e.getAttribute('rel') || '')) page.links.push(e.getAttribute('href'));
        }});
    // Cut off very big pages.
    const reader = response.body.getReader();
    let size = 0;
    const limited = new ReadableStream({
        async pull (controller) {
            const {done, value} = await reader.read();
            if (done || size > SWISS_HTML_MAX) { controller.close(); reader.cancel().catch(() => {}); return; }
            size += value.byteLength;
            controller.enqueue(value);
        }
    });
    await rewriter.transform(new Response(limited, {headers: {'content-type': 'text/html'}})).arrayBuffer();
    const tidy = s => s.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#0?39;|&apos;/g, '\'').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();
    page.title = tidy(page.title);
    page.description = tidy(page.description);
    page.text = tidy(page.text).slice(0, SWISS_TEXT_MAX);
    return page;
};

const swissCrawlOne = async (d, row) => {
    const {url, host, depth} = row;
    await d.prepare('UPDATE swiss_urls SET status = 2, tries = tries + 1, visited = ? WHERE url = ?').bind(Date.now(), url).run();
    const rules = await swissRobots(d, host);
    const u = new URL(url);
    if (!swissRobotsAllow(rules, u.pathname + u.search)) {
        await d.prepare('UPDATE swiss_urls SET status = 3 WHERE url = ?').bind(url).run();
        return 'robots';
    }
    let response;
    try {
        response = await fetch(url, {headers: {'user-agent': SWISS_AGENT, 'accept': 'text/html', 'accept-language': 'en, id;q=0.8'}, redirect: 'follow'});
    } catch (e) { return 'error'; }
    const finalUrl = swissNormalize(response.url || url, url);
    const type = response.headers.get('content-type') || '';
    if (!response.ok || !/text\/html|application\/xhtml/i.test(type) || /noindex/i.test(response.headers.get('x-robots-tag') || '')) {
        await d.prepare('UPDATE swiss_urls SET status = 3 WHERE url = ?').bind(url).run();
        return 'skip';
    }
    if (finalUrl && finalUrl !== url && new URL(finalUrl).hostname !== host && !(await swissHostAllowed(d, new URL(finalUrl).hostname))) {
        await d.prepare('UPDATE swiss_urls SET status = 3 WHERE url = ?').bind(url).run();
        return 'left';
    }
    const page = await swissRead(response);
    const all = `${page.title} ${page.description} ${page.text}`;
    BAD_WORDS.lastIndex = 0;
    const badHits = (all.match(BAD_WORDS) || []).length;
    const keep = !page.noindex && page.text.length > 80 && badHits < 2;
    const stmts = [d.prepare('DELETE FROM swiss_fts WHERE url = ?').bind(url)];
    if (keep) {
        stmts.push(d.prepare('INSERT INTO swiss_fts (url, title, description, body, host) VALUES (?, ?, ?, ?, ?)')
            .bind(url, page.title || u.hostname, page.description, page.text, host));
        stmts.push(d.prepare('UPDATE swiss_hosts SET pages = pages + 1, last = ? WHERE host = ?').bind(Date.now(), host));
    }
    stmts.push(d.prepare('UPDATE swiss_urls SET status = 1 WHERE url = ?').bind(url));
    await d.batch(stmts);
    if (!page.nofollow && depth < 6 && badHits < 2) {
        const seen = new Set(), next = [];
        for (const href of page.links) {
            const n = swissNormalize(href, finalUrl || url);
            if (!n || seen.has(n)) continue;
            seen.add(n);
            const h = new URL(n).hostname;
            if (h === host || swissSeedHosts().includes(h)) next.push(n);
            if (next.length >= SWISS_LINKS_PER_PAGE) break;
        }
        if (next.length) await swissQueue(d, next, depth + 1);
    }
    return keep ? 'saved' : 'empty';
};

const swissCrawl = async env => {
    const d = await swissDb(env);
    if (!d) return {error: 'No SH_DB database.'};
    const count = await d.prepare('SELECT COUNT(*) AS n FROM swiss_urls').first();
    if (!count || !count.n) await swissQueue(d, SWISS_SEEDS.map(s => swissNormalize(s, s)).filter(Boolean), 0);
    // Pages that failed a lot are dropped; ones that look stuck go back in the queue.
    await d.prepare('UPDATE swiss_urls SET status = 0 WHERE status = 2 AND tries < 3 AND visited < ?').bind(Date.now() - 3600e3).run();
    // Revisit old pages now and then so the index stays fresh.
    await d.prepare('UPDATE swiss_urls SET status = 0, tries = 0 WHERE rowid IN (SELECT rowid FROM swiss_urls WHERE status = 1 AND visited < ? LIMIT 2)').bind(Date.now() - SWISS_REVISIT_DAYS * 864e5).run();
    const candidates = (await d.prepare(`SELECT u.url, u.host, u.depth FROM swiss_urls u LEFT JOIN swiss_hosts h ON h.host = u.host
        WHERE u.status = 0 AND IFNULL(h.pages, 0) < ? ORDER BY u.depth, u.added LIMIT 60`).bind(SWISS_HOST_MAX).all()).results || [];
    // One page per website each run, and websites read most recently go last.
    const lastByHost = {};
    for (const r of (await d.prepare('SELECT host, last FROM swiss_hosts').all()).results || []) lastByHost[r.host] = r.last;
    const picked = [], hosts = new Set();
    candidates.sort((a, b) => (lastByHost[a.host] || 0) - (lastByHost[b.host] || 0) || a.depth - b.depth);
    for (const c of candidates) {
        if (hosts.has(c.host)) continue;
        if (!(await swissHostAllowed(d, c.host))) {
            await d.prepare('UPDATE swiss_urls SET status = 3 WHERE url = ?').bind(c.url).run();
            continue;
        }
        hosts.add(c.host);
        picked.push(c);
        if (picked.length >= SWISS_PAGES_PER_RUN) break;
    }
    const results = [];
    for (const row of picked) {
        await d.prepare('INSERT OR IGNORE INTO swiss_hosts (host) VALUES (?)').bind(row.host).run();
        await d.prepare('UPDATE swiss_hosts SET last = ? WHERE host = ?').bind(Date.now(), row.host).run();
        try { results.push([row.url, await swissCrawlOne(d, row)]); } catch (e) { results.push([row.url, 'error: ' + e.message]); }
    }
    return {results};
};

// Search words become an FTS5 query: every word must match (word* also finds longer words).
const swissMatch = (q, any) => {
    let words = (String(q).toLowerCase().match(/[\p{L}\p{N}]+/gu) || []).slice(0, 8);
    const meaningful = words.filter(w => !/^(the|a|an|of|in|on|at|for|to|and|or|is|are|what|how|who|where|why|me|my|i|yang|di|dan|ke|dari)$/.test(w));
    if (meaningful.length) words = meaningful;
    if (!words.length) return null;
    return words.map(w => `"${w}"${w.length > 2 ? '*' : ''}`).join(any ? ' OR ' : ' ');
};

const handleSwissSearch = async (env, cors, url) => {
    const d = await swissDb(env);
    if (!d) return json(503, {error: 'Swiss isn\'t switched on yet.'}, cors);
    const q = (url.searchParams.get('q') || '').slice(0, 200);
    const page = Math.max(0, Math.min(9, parseInt(url.searchParams.get('page') || '0', 10) || 0));
    const run = async any => {
        const match = swissMatch(q, any);
        if (!match) return [];
        return (await d.prepare(`SELECT url, title, description,
                snippet(swiss_fts, 3, char(1), char(2), '…', 28) AS snip, host
            FROM swiss_fts WHERE swiss_fts MATCH ? ORDER BY bm25(swiss_fts, 0, 10, 4, 1) LIMIT 11 OFFSET ?`)
            .bind(match, page * 10).all()).results || [];
    };
    let results = [], loose = false;
    try {
        results = await run(false);
        if (!results.length && !page) { results = await run(true); loose = true; }
    } catch (e) {
        return json(400, {error: 'Swiss couldn\'t understand that search.'}, cors);
    }
    return json(200, {results: results.slice(0, 10), more: results.length > 10, loose}, {...cors, 'cache-control': 'public, max-age=300'});
};

const handleSwissStats = async (env, cors) => {
    const d = await swissDb(env);
    if (!d) return json(503, {error: 'Swiss isn\'t switched on yet.'}, cors);
    const pages = await d.prepare('SELECT COUNT(*) AS n FROM swiss_fts').first();
    const sites = await d.prepare('SELECT COUNT(*) AS n FROM swiss_hosts WHERE pages > 0').first();
    const waiting = await d.prepare('SELECT COUNT(*) AS n FROM swiss_urls WHERE status = 0').first();
    return json(200, {pages: pages.n, sites: sites.n, waiting: waiting.n}, {...cors, 'cache-control': 'public, max-age=120'});
};

const handleSwissSuggest = async (request, env, cors) => {
    const d = await swissDb(env);
    if (!d) return json(503, {error: 'Swiss isn\'t switched on yet.'}, cors);
    let body;
    try { body = await request.json(); } catch (e) { return json(400, {error: 'Bad request'}, cors); }
    let raw = String(body.url || '').trim();
    if (raw && !/^https?:\/\//i.test(raw)) raw = 'https://' + raw;
    const n = swissNormalize(raw, raw);
    if (!n) return json(400, {error: 'That doesn\'t look like a website address.'}, cors);
    const host = new URL(n).hostname;
    if (!/\./.test(host) || /^(\d+\.){3}\d+$/.test(host)) return json(400, {error: 'That doesn\'t look like a website address.'}, cors);
    if (await swissHostAllowed(d, host)) {
        await swissQueue(d, [n], 0);
        return json(200, {ok: true, message: 'Swiss already reads that website. It will visit that page soon.'}, cors);
    }
    const key = `sug:${today()}:${clientIp(request)}`;
    const used = await d.prepare('SELECT n FROM swiss_rate WHERE k = ?').bind(key).first();
    if (used && used.n >= SWISS_SUGGEST_DAILY) return json(429, {error: 'That\'s enough suggestions for today. Thank you!'}, cors);
    await d.batch([
        d.prepare('INSERT INTO swiss_rate (k, n) VALUES (?, 1) ON CONFLICT(k) DO UPDATE SET n = n + 1').bind(key),
        d.prepare('DELETE FROM swiss_rate WHERE k NOT LIKE ?').bind(`sug:${today()}:%`),
        d.prepare('INSERT OR IGNORE INTO swiss_suggest (host, url, created) VALUES (?, ?, ?)').bind(host, n, Date.now())
    ]);
    return json(200, {ok: true, message: 'Thanks! The owner will check the website, then Swiss will start reading it.'}, cors);
};

// The owner sees suggested websites and approves or removes them.
const handleSwissOwner = async (request, env, cors) => {
    if (!isOwner(request, env)) return json(403, {error: 'Owner only.'}, cors);
    const d = await swissDb(env);
    if (!d) return json(503, {error: 'No SH_DB database.'}, cors);
    let body = {};
    try { body = await request.json(); } catch (e) { /* list */ }
    const host = String(body.host || '').toLowerCase();
    if (body.action === 'approve' && host) {
        const row = await d.prepare('SELECT url FROM swiss_suggest WHERE host = ?').bind(host).first();
        await d.batch([
            d.prepare('INSERT INTO swiss_hosts (host, allowed) VALUES (?, 1) ON CONFLICT(host) DO UPDATE SET allowed = 1').bind(host),
            d.prepare('DELETE FROM swiss_suggest WHERE host = ?').bind(host)
        ]);
        await swissQueue(d, [row ? row.url : `https://${host}/`], 0);
    } else if (body.action === 'reject' && host) {
        await d.prepare('DELETE FROM swiss_suggest WHERE host = ?').bind(host).run();
    } else if (body.action === 'block' && host) {
        // Take a website out of Swiss completely.
        await d.batch([
            d.prepare('INSERT INTO swiss_hosts (host, allowed) VALUES (?, 0) ON CONFLICT(host) DO UPDATE SET allowed = 0, pages = 0').bind(host),
            d.prepare('DELETE FROM swiss_fts WHERE host = ?').bind(host),
            d.prepare('UPDATE swiss_urls SET status = 3 WHERE host = ?').bind(host),
            d.prepare('DELETE FROM swiss_suggest WHERE host = ?').bind(host)
        ]);
    } else if (body.action === 'crawl') {
        return json(200, await swissCrawl(env), cors);
    }
    const suggestions = (await d.prepare('SELECT host, url, created FROM swiss_suggest ORDER BY created LIMIT 100').all()).results || [];
    const sites = (await d.prepare('SELECT host, allowed, pages FROM swiss_hosts WHERE pages > 0 OR allowed = 1 ORDER BY pages DESC LIMIT 200').all()).results || [];
    return json(200, {suggestions, sites}, cors);
};

// ---------------------------------------------------------------- WorkSheet++ and Web Store uploads
// Both use the same D1 database (binding SH_DB). WorkSheet++ saves each account's progress, and makes
// worksheets with Cloudflare Workers AI (binding AI, free daily allowance) for courses people write
// themselves. Built-in courses (fractions, English) are made in the browser and need no AI.
// Web Store: people with an account submit apps (files stay on their own site, like GitHub Releases
// or itch.io); nothing is shown until the owner approves it.

const WS_SAVE_MAX = 200 * 1024;
const WS_AI_DAILY_TOTAL = 150;   // AI worksheets per day for everyone together
const WS_AI_DAILY_USER = 6;      // AI worksheets per account per day
const WS_AI_MODEL = '@cf/meta/llama-3.1-8b-instruct';
const STORE_CATEGORIES = ['game', 'education', 'tool', 'creative', 'browser', 'other'];
const STORE_PLATFORMS = ['web', 'windows', 'mac', 'linux', 'android', 'ios'];
const STORE_PER_USER = 10;
const STORE_IMG_MAX = 300 * 1024; // one picture, as a data: URL

let extraReady = null;
const extraDb = env => {
    if (!env.SH_DB) return null;
    if (!extraReady) {
        extraReady = env.SH_DB.batch([
            'CREATE TABLE IF NOT EXISTS ws_progress (login TEXT PRIMARY KEY, data TEXT NOT NULL, updated INTEGER NOT NULL)',
            'CREATE TABLE IF NOT EXISTS ws_rate (k TEXT PRIMARY KEY, n INTEGER NOT NULL)',
            'CREATE TABLE IF NOT EXISTS ws_feedback (id INTEGER PRIMARY KEY AUTOINCREMENT, login TEXT NOT NULL, course TEXT, question TEXT, note TEXT, created INTEGER NOT NULL)',
            'CREATE TABLE IF NOT EXISTS store_apps (id TEXT PRIMARY KEY, owner TEXT NOT NULL, name TEXT NOT NULL, tagline TEXT, description TEXT, category TEXT, platforms TEXT, url TEXT NOT NULL, status TEXT NOT NULL, note TEXT, shots INTEGER NOT NULL DEFAULT 0, version INTEGER NOT NULL DEFAULT 1, created INTEGER NOT NULL, updated INTEGER NOT NULL)',
            'CREATE INDEX IF NOT EXISTS store_apps_status ON store_apps (status, updated)',
            'CREATE INDEX IF NOT EXISTS store_apps_owner ON store_apps (owner)',
            'CREATE TABLE IF NOT EXISTS store_images (app TEXT NOT NULL, n INTEGER NOT NULL, data TEXT NOT NULL, PRIMARY KEY (app, n))',
            'CREATE TABLE IF NOT EXISTS store_ratings (app TEXT NOT NULL, login TEXT NOT NULL, stars INTEGER NOT NULL, PRIMARY KEY (app, login))',
            'CREATE TABLE IF NOT EXISTS store_reports (id INTEGER PRIMARY KEY AUTOINCREMENT, app TEXT NOT NULL, login TEXT NOT NULL, reason TEXT, created INTEGER NOT NULL)'
        ].map(sql => env.SH_DB.prepare(sql))).catch(e => {
            extraReady = null;
            throw e;
        });
    }
    return extraReady.then(() => env.SH_DB);
};

const needAccount = async (request, env, cors) => {
    const user = await sessionUser(request, env);
    if (!user) return {error: json(401, {error: 'Sign in with GitHub first.'}, cors)};
    const d = await extraDb(env);
    if (!d) return {error: json(503, {error: 'This isn\'t switched on yet. The owner needs to add the SH_DB database.'}, cors)};
    return {user, me: lc(user.login), d};
};

const bump = async (d, key, limit) => {
    const row = await d.prepare('SELECT n FROM ws_rate WHERE k = ?').bind(key).first();
    if (row && row.n >= limit) return false;
    await d.prepare('INSERT INTO ws_rate (k, n) VALUES (?, 1) ON CONFLICT(k) DO UPDATE SET n = n + 1').bind(key).run();
    return true;
};

// ----- WorkSheet++

const handleWsLoad = async (request, env, cors) => {
    const a = await needAccount(request, env, cors);
    if (a.error) return a.error;
    const row = await a.d.prepare('SELECT data, updated FROM ws_progress WHERE login = ?').bind(a.me).first();
    return json(200, {data: row ? JSON.parse(row.data) : null, updated: row ? row.updated : 0}, cors);
};

const handleWsSave = async (request, env, cors) => {
    const a = await needAccount(request, env, cors);
    if (a.error) return a.error;
    const text = await request.text();
    if (text.length > WS_SAVE_MAX) return json(413, {error: 'Too much to save.'}, cors);
    let body;
    try { body = JSON.parse(text); } catch (e) { return json(400, {error: 'Bad request'}, cors); }
    if (!body || typeof body.data !== 'object') return json(400, {error: 'Bad request'}, cors);
    const now = Date.now();
    await a.d.prepare('INSERT INTO ws_progress (login, data, updated) VALUES (?, ?, ?) ON CONFLICT(login) DO UPDATE SET data = excluded.data, updated = excluded.updated')
        .bind(a.me, JSON.stringify(body.data), now).run();
    return json(200, {ok: true, updated: now}, cors);
};

const wsClean = (value, max) => {
    BAD_WORDS.lastIndex = 0;
    const s = cleanText(value, max);
    BAD_WORDS.lastIndex = 0;
    return BAD_WORDS.test(s) ? null : s;
};

// Turn what the AI wrote into safe, checked questions.
const wsQuestions = raw => {
    let text = String(raw || '');
    const start = text.indexOf('{'), end = text.lastIndexOf('}');
    if (start < 0 || end < start) return [];
    let parsed;
    try { parsed = JSON.parse(text.slice(start, end + 1)); } catch (e) { return []; }
    const list = Array.isArray(parsed.questions) ? parsed.questions : [];
    const out = [];
    for (const q of list.slice(0, 15)) {
        const prompt = wsClean(q && q.q, 300);
        if (!prompt) continue;
        const explain = wsClean(q.explain || '', 300) || '';
        if (Array.isArray(q.options) && q.options.length >= 2) {
            const options = q.options.slice(0, 4).map(o => wsClean(o, 120)).filter(o => o);
            const answer = typeof q.answer === 'number' ? q.answer : options.indexOf(wsClean(q.answer, 120));
            if (options.length >= 2 && answer >= 0 && answer < options.length && new Set(options).size === options.length) {
                // the AI likes to put the right answer first: mix the options up
                const right = options[answer];
                for (let i = options.length - 1; i > 0; i--) {
                    const j = Math.floor(Math.random() * (i + 1));
                    [options[i], options[j]] = [options[j], options[i]];
                }
                out.push({type: 'choice', q: prompt, options, answer: options.indexOf(right), explain});
            }
        } else if (q.answer !== undefined && q.answer !== null) {
            const answer = wsClean(q.answer, 80);
            if (answer) out.push({type: 'type', q: prompt, answer, explain});
        }
    }
    return out;
};

const handleWsGenerate = async (request, env, cors) => {
    const a = await needAccount(request, env, cors);
    if (a.error) return a.error;
    if (!env.AI) return json(503, {error: 'The AI isn\'t switched on yet. Built-in courses still work.', noAi: true}, cors);
    let body;
    try { body = await request.json(); } catch (e) { return json(400, {error: 'Bad request'}, cors); }
    const subject = wsClean(body.subject, 120);
    const goal = wsClean(body.goal || '', 300) || '';
    const level = Math.max(1, Math.min(10, parseInt(body.level, 10) || 1));
    const mistakes = (Array.isArray(body.mistakes) ? body.mistakes : []).slice(0, 5).map(m => wsClean(m, 150)).filter(Boolean);
    if (!subject) return json(400, {error: 'Write what you want to learn (and keep it friendly).'}, cors);
    if (!(await bump(a.d, `ai:${today()}:all`, WS_AI_DAILY_TOTAL))) {
        return json(429, {error: 'The AI has made all its free worksheets for today. Try again tomorrow, or practise a built-in course!', noAi: true}, cors);
    }
    if (!(await bump(a.d, `ai:${today()}:${a.me}`, WS_AI_DAILY_USER))) {
        return json(429, {error: 'That\'s all your AI worksheets for today. Come back tomorrow!'}, cors);
    }
    await a.d.prepare('DELETE FROM ws_rate WHERE k LIKE ? AND k NOT LIKE ?').bind('ai:%', `ai:${today()}:%`).run();
    const system = 'You write short, friendly practice worksheets for children and teenagers on a kids website. ' +
        'Only school-appropriate content. Reply with JSON only, no other text, in this shape: ' +
        '{"title":"...","questions":[{"q":"question","options":["a","b","c","d"],"answer":0,"explain":"one short sentence"},' +
        '{"q":"question with one short exact answer","answer":"word or number","explain":"..."}]}. ' +
        'Make 8 questions: mostly multiple choice with 4 different options (answer is the index of the right option), and 2 or 3 typed answers of one word or number. ' +
        'Every answer must be correct. Questions must not repeat.';
    const user = `Subject: ${subject}\nLevel: ${level} of 10 (1 = complete beginner, 10 = advanced)\n` +
        (goal ? `What the learner wants: ${goal}\n` : '') +
        (mistakes.length ? `Include practice on things they got wrong before: ${mistakes.join(' | ')}\n` : '') +
        `Worksheet for ${today()}. Make it different from other days.`;
    let result;
    try {
        result = await env.AI.run(WS_AI_MODEL, {messages: [{role: 'system', content: system}, {role: 'user', content: user}], max_tokens: 1800, temperature: 0.7});
    } catch (e) {
        return json(502, {error: 'The AI is busy right now. Try again in a minute.'}, cors);
    }
    const raw = typeof result === 'string' ? result : (result && (result.response || (result.result && result.result.response))) || '';
    const questions = wsQuestions(typeof raw === 'object' ? JSON.stringify(raw) : raw);
    if (questions.length < 4) return json(502, {error: 'The AI made a messy worksheet. Press try again.'}, cors);
    let title = '';
    try { title = wsClean(JSON.parse(String(raw).slice(String(raw).indexOf('{'), String(raw).lastIndexOf('}') + 1)).title, 80) || ''; } catch (e) { /* no title */ }
    return json(200, {title: title || subject, questions}, cors);
};

const handleWsFeedback = async (request, env, cors) => {
    const a = await needAccount(request, env, cors);
    if (a.error) return a.error;
    let body;
    try { body = await request.json(); } catch (e) { return json(400, {error: 'Bad request'}, cors); }
    if (!(await bump(a.d, `fb:${today()}:${a.me}`, 30))) return json(429, {error: 'Thanks, that\'s enough for today!'}, cors);
    await a.d.prepare('INSERT INTO ws_feedback (login, course, question, note, created) VALUES (?, ?, ?, ?, ?)')
        .bind(a.me, cleanText(body.course, 120), cleanText(body.question, 400), cleanText(body.note, 300), Date.now()).run();
    return json(200, {ok: true}, cors);
};

// ----- Web Store

const storeUrl = value => {
    try {
        const u = new URL(String(value || '').trim());
        if (u.protocol !== 'https:' || u.username || u.password) return null;
        return u.toString().slice(0, 400);
    } catch (e) {
        return null;
    }
};

const storeImageOk = data => typeof data === 'string' && data.length <= STORE_IMG_MAX && /^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(data);

const storeCard = (row, base, ratings) => {
    const r = ratings && ratings[row.id];
    return {
        id: row.id, owner: row.owner, name: row.name, tagline: row.tagline || '', description: row.description || '',
        category: row.category, platforms: (row.platforms || '').split(',').filter(Boolean), url: row.url,
        status: row.status, note: row.note || '', updated: row.updated,
        icon: `${base}/store/img/${row.id}/0?v=${row.version}`,
        shots: Array.from({length: row.shots}, (x, i) => `${base}/store/img/${row.id}/${i + 1}?v=${row.version}`),
        stars: r ? Math.round(r.avg * 10) / 10 : 0, votes: r ? r.n : 0
    };
};

const storeRatings = async (d, ids) => {
    if (!ids.length) return {};
    const rows = (await d.prepare(`SELECT app, AVG(stars) AS avg, COUNT(*) AS n FROM store_ratings WHERE app IN (${ids.map(() => '?').join(',')}) GROUP BY app`).bind(...ids).all()).results || [];
    const out = {};
    for (const r of rows) out[r.app] = r;
    return out;
};

const handleStoreApps = async (request, env, cors, base, url) => {
    const d = await extraDb(env);
    if (!d) return json(200, {apps: [], off: true}, cors);
    const by = lc(url.searchParams.get('by') || '');
    let rows;
    if (url.searchParams.get('mine')) {
        const user = await sessionUser(request, env);
        if (!user) return json(401, {error: 'Sign in with GitHub first.'}, cors);
        rows = (await d.prepare('SELECT * FROM store_apps WHERE owner = ? ORDER BY updated DESC').bind(lc(user.login)).all()).results || [];
    } else if (by) {
        rows = (await d.prepare('SELECT * FROM store_apps WHERE owner = ? AND status = ? ORDER BY updated DESC LIMIT 50').bind(by, 'approved').all()).results || [];
    } else {
        rows = (await d.prepare('SELECT * FROM store_apps WHERE status = ? ORDER BY updated DESC LIMIT 200').bind('approved').all()).results || [];
    }
    const ratings = await storeRatings(d, rows.map(r => r.id));
    return json(200, {apps: rows.map(r => storeCard(r, base, ratings))}, {...cors, 'cache-control': 'no-store'});
};

const handleStoreImage = async (env, id, n) => {
    const d = await extraDb(env);
    if (!d) return new Response('Not found', {status: 404});
    const row = await d.prepare('SELECT data FROM store_images WHERE app = ? AND n = ?').bind(id, n).first();
    if (!row) return new Response('Not found', {status: 404});
    const m = /^data:(image\/[a-z]+);base64,(.*)$/.exec(row.data);
    const bytes = Uint8Array.from(atob(m[2]), c => c.charCodeAt(0));
    return new Response(bytes, {headers: {'content-type': m[1], 'cache-control': 'public, max-age=86400', 'access-control-allow-origin': '*', 'x-content-type-options': 'nosniff'}});
};

const handleStoreSubmit = async (request, env, cors, base) => {
    const a = await needAccount(request, env, cors);
    if (a.error) return a.error;
    const text = await request.text();
    if (text.length > STORE_IMG_MAX * 4 + 20000) return json(413, {error: 'The pictures are too big.'}, cors);
    let body;
    try { body = JSON.parse(text); } catch (e) { return json(400, {error: 'Bad request'}, cors); }
    const name = wsClean(body.name, 40), tagline = wsClean(body.tagline || '', 80), description = wsClean(body.description || '', 1500);
    if (!name) return json(400, {error: 'Give your app a friendly name.'}, cors);
    if (tagline === null || description === null) return json(400, {error: 'Please keep the words friendly.'}, cors);
    const url = storeUrl(body.url);
    if (!url) return json(400, {error: 'Add a link that starts with https:// to where people get your app.'}, cors);
    const category = STORE_CATEGORIES.includes(body.category) ? body.category : 'other';
    const platforms = (Array.isArray(body.platforms) ? body.platforms : []).filter(p => STORE_PLATFORMS.includes(p));
    if (!platforms.length) return json(400, {error: 'Pick at least one device your app works on.'}, cors);
    const shots = (Array.isArray(body.shots) ? body.shots : []).slice(0, 3);
    if (shots.some(s => !storeImageOk(s))) return json(400, {error: 'One of the screenshots isn\'t a picture.'}, cors);
    const now = Date.now();
    let id = String(body.id || '');
    let existing = null;
    if (id) {
        existing = await a.d.prepare('SELECT * FROM store_apps WHERE id = ?').bind(id).first();
        if (!existing || existing.owner !== a.me) return json(403, {error: 'That isn\'t your app.'}, cors);
    } else {
        const count = await a.d.prepare('SELECT COUNT(*) AS n FROM store_apps WHERE owner = ?').bind(a.me).first();
        if (count.n >= STORE_PER_USER) return json(429, {error: `You can have up to ${STORE_PER_USER} apps.`}, cors);
        if (!(await bump(a.d, `st:${today()}:${a.me}`, 5))) return json(429, {error: 'That\'s enough new apps for today.'}, cors);
        id = Array.from(crypto.getRandomValues(new Uint8Array(6)), b => (b % 36).toString(36)).join('');
    }
    const icon = body.icon;
    if (!existing && !storeImageOk(icon)) return json(400, {error: 'Add an icon for your app.'}, cors);
    if (icon && !storeImageOk(icon)) return json(400, {error: 'The icon isn\'t a picture.'}, cors);
    const stmts = [];
    if (existing) {
        const keepShots = body.keepShots && !shots.length;
        stmts.push(a.d.prepare('UPDATE store_apps SET name = ?, tagline = ?, description = ?, category = ?, platforms = ?, url = ?, status = ?, note = NULL, shots = ?, version = version + 1, updated = ? WHERE id = ?')
            .bind(name, tagline, description, category, platforms.join(','), url, 'pending', keepShots ? existing.shots : shots.length, now, id));
        if (!keepShots) stmts.push(a.d.prepare('DELETE FROM store_images WHERE app = ? AND n > 0').bind(id));
    } else {
        stmts.push(a.d.prepare('INSERT INTO store_apps (id, owner, name, tagline, description, category, platforms, url, status, shots, created, updated) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
            .bind(id, a.me, name, tagline, description, category, platforms.join(','), url, 'pending', shots.length, now, now));
    }
    if (icon) stmts.push(a.d.prepare('INSERT OR REPLACE INTO store_images (app, n, data) VALUES (?, 0, ?)').bind(id, icon));
    shots.forEach((s, i) => stmts.push(a.d.prepare('INSERT OR REPLACE INTO store_images (app, n, data) VALUES (?, ?, ?)').bind(id, i + 1, s)));
    await a.d.batch(stmts);
    return json(200, {ok: true, id, message: 'Sent! The owner will check your app, then it shows up in the Web Store.'}, cors);
};

const handleStoreDelete = async (request, env, cors) => {
    const a = await needAccount(request, env, cors);
    if (a.error) return a.error;
    let body;
    try { body = await request.json(); } catch (e) { return json(400, {error: 'Bad request'}, cors); }
    const row = await a.d.prepare('SELECT owner FROM store_apps WHERE id = ?').bind(String(body.id || '')).first();
    if (!row || row.owner !== a.me) return json(403, {error: 'That isn\'t your app.'}, cors);
    await a.d.batch(['store_apps WHERE id', 'store_images WHERE app', 'store_ratings WHERE app', 'store_reports WHERE app']
        .map(t => a.d.prepare(`DELETE FROM ${t} = ?`).bind(String(body.id))));
    return json(200, {ok: true}, cors);
};

const handleStoreRate = async (request, env, cors) => {
    const a = await needAccount(request, env, cors);
    if (a.error) return a.error;
    let body;
    try { body = await request.json(); } catch (e) { return json(400, {error: 'Bad request'}, cors); }
    const stars = parseInt(body.stars, 10);
    if (!(stars >= 1 && stars <= 5)) return json(400, {error: 'Pick 1 to 5 stars.'}, cors);
    const row = await a.d.prepare('SELECT owner FROM store_apps WHERE id = ? AND status = ?').bind(String(body.id || ''), 'approved').first();
    if (!row) return json(404, {error: 'App not found.'}, cors);
    if (row.owner === a.me) return json(400, {error: 'You can\'t rate your own app.'}, cors);
    await a.d.prepare('INSERT INTO store_ratings (app, login, stars) VALUES (?, ?, ?) ON CONFLICT(app, login) DO UPDATE SET stars = excluded.stars').bind(String(body.id), a.me, stars).run();
    const r = (await storeRatings(a.d, [String(body.id)]))[String(body.id)];
    return json(200, {ok: true, stars: Math.round(r.avg * 10) / 10, votes: r.n}, cors);
};

const handleStoreReport = async (request, env, cors) => {
    const a = await needAccount(request, env, cors);
    if (a.error) return a.error;
    let body;
    try { body = await request.json(); } catch (e) { return json(400, {error: 'Bad request'}, cors); }
    if (!(await bump(a.d, `rp:${today()}:${a.me}`, 10))) return json(429, {error: 'Thanks, that\'s enough reports for today.'}, cors);
    await a.d.prepare('INSERT INTO store_reports (app, login, reason, created) VALUES (?, ?, ?, ?)').bind(String(body.id || '').slice(0, 20), a.me, cleanText(body.reason, 300), Date.now()).run();
    return json(200, {ok: true, message: 'Thanks for telling us. The owner will check it.'}, cors);
};

const handleStoreOwner = async (request, env, cors, base) => {
    if (!isOwner(request, env)) return json(403, {error: 'Owner only.'}, cors);
    const d = await extraDb(env);
    if (!d) return json(503, {error: 'No SH_DB database.'}, cors);
    let body = {};
    try { body = await request.json(); } catch (e) { /* list */ }
    const id = String(body.id || '');
    if (body.action === 'approve' && id) await d.prepare('UPDATE store_apps SET status = ?, note = NULL WHERE id = ?').bind('approved', id).run();
    if (body.action === 'reject' && id) await d.prepare('UPDATE store_apps SET status = ?, note = ? WHERE id = ?').bind('rejected', cleanText(body.note, 300), id).run();
    if (body.action === 'remove' && id) {
        await d.batch(['store_apps WHERE id', 'store_images WHERE app', 'store_ratings WHERE app', 'store_reports WHERE app'].map(t => d.prepare(`DELETE FROM ${t} = ?`).bind(id)));
    }
    if (body.action === 'dismiss' && body.report) await d.prepare('DELETE FROM store_reports WHERE id = ?').bind(parseInt(body.report, 10) || 0).run();
    const pending = (await d.prepare('SELECT * FROM store_apps WHERE status = ? ORDER BY updated LIMIT 100').bind('pending').all()).results || [];
    const reports = (await d.prepare('SELECT r.id, r.app, r.login, r.reason, r.created, a.name FROM store_reports r LEFT JOIN store_apps a ON a.id = r.app ORDER BY r.created DESC LIMIT 100').all()).results || [];
    const feedback = (await d.prepare('SELECT login, course, question, note, created FROM ws_feedback ORDER BY id DESC LIMIT 50').all()).results || [];
    return json(200, {pending: pending.map(r => storeCard(r, base)), reports, feedback}, cors);
};

// ---------------------------------------------------------------- router

export default {
    async fetch (request, env) {
        const origin = request.headers.get('Origin') || '';
        const cors = corsHeaders(origin);
        if (request.method === 'OPTIONS') return new Response(null, {status: 204, headers: cors});
        const url = new URL(request.url);
        const path = url.pathname.replace(/\/+$/, '');

        const base = url.origin;
        // Signing in with GitHub (the browser goes here directly).
        if (request.method === 'GET' && path === '/auth/login') return handleLogin(request, env, url);
        if (request.method === 'GET' && path === '/auth/callback') return handleCallback(request, env, url);

        // Reading the Game Hub and profiles is open to everyone.
        if (request.method === 'GET') {
            if (path === '/auth/status') return json(200, {accounts: !!(env.GITHUB_CLIENT_ID && env.GITHUB_CLIENT_SECRET)}, cors);
            if (path === '/me') return handleMe(request, env, cors, base);
            const u = /^\/u\/([A-Za-z0-9-]{1,39})$/.exec(path);
            if (u) return handleProfile(env, cors, base, u[1]);
            const im = /^\/img\/(avatar|banner)\/([0-9]{1,20})$/.exec(path);
            if (im) return handleImage(env, cors, im[1], im[2]);
            if (path === '/friends') return handleFriends(request, env, cors, base);
            if (path === '/chat/unread') return handleUnread(request, env, cors);
            const cw = /^\/chat\/with\/([A-Za-z0-9-]{1,39})$/.exec(path);
            if (cw) return handleChatRead(request, env, cors, cw[1], url);
            if (path === '/swiss/search') return handleSwissSearch(env, cors, url);
            if (path === '/swiss/stats') return handleSwissStats(env, cors);
            if (path === '/ws/load') return handleWsLoad(request, env, cors);
            if (path === '/store/apps') return handleStoreApps(request, env, cors, base, url);
            const si = /^\/store\/img\/([a-z0-9]{4,20})\/([0-3])$/.exec(path);
            if (si) return handleStoreImage(env, si[1], +si[2]);
            if (path === '/hub/list') return handleList(env, cors);
            const m = /^\/hub\/(info|file|thumb)\/([a-z0-9]{4,20})$/.exec(path);
            if (m) return m[1] === 'info' ? handleInfo(env, cors, m[2]) : handleFile(env, cors, m[2], m[1]);
            return json(404, {error: 'Not found'}, cors);
        }
        if (request.method !== 'POST') return json(404, {error: 'Not found'}, cors);

        // Everything that changes something only works from Stick Lab and the Stick Hubs website.
        if (!ALLOWED_ORIGINS.includes(origin)) {
            return json(403, {error: 'This only works inside Stick Lab and on Stick Hubs.'}, cors);
        }
        if (path === '/chat') return handleChat(request, env, cors);
        if (path === '/hub/publish') return handlePublish(request, env, cors);
        if (path === '/hub/report') return handleReport(request, env, cors);
        if (path === '/hub/delete') return handleDelete(request, env, cors);
        if (path === '/auth/logout') return handleLogout(request, env, cors);
        if (path === '/me') return handleMe(request, env, cors, base);
        if (path === '/me/avatar') return handleMeImage(request, env, cors, base, 'avatar');
        if (path === '/me/banner') return handleMeImage(request, env, cors, base, 'banner');
        if (path === '/u/report') return handleProfileReport(request, env, cors);
        const fa = /^\/friends\/(request|accept|decline|remove|block|unblock)$/.exec(path);
        if (fa) return handleFriendAction(request, env, cors, fa[1]);
        if (path === '/chat/send') return handleChatSend(request, env, cors);
        if (path === '/chat/report') return handleChatReport(request, env, cors);
        if (path === '/owner/reports') return handleOwnerReports(request, env, cors);
        if (path === '/swiss/suggest') return handleSwissSuggest(request, env, cors);
        if (path === '/owner/swiss') return handleSwissOwner(request, env, cors);
        if (path === '/ws/save') return handleWsSave(request, env, cors);
        if (path === '/ws/generate') return handleWsGenerate(request, env, cors);
        if (path === '/ws/feedback') return handleWsFeedback(request, env, cors);
        if (path === '/store/submit') return handleStoreSubmit(request, env, cors, base);
        if (path === '/store/delete') return handleStoreDelete(request, env, cors);
        if (path === '/store/rate') return handleStoreRate(request, env, cors);
        if (path === '/store/report') return handleStoreReport(request, env, cors);
        if (path === '/owner/store') return handleStoreOwner(request, env, cors, base);
        return json(404, {error: 'Not found'}, cors);
    },

    // Cron Trigger (Settings > Triggers > Cron, for example every 2 minutes): SwissBot reads a few pages.
    async scheduled (event, env, ctx) {
        ctx.waitUntil(swissCrawl(env).catch(e => console.log('SwissBot', e.message)));
    }
};
