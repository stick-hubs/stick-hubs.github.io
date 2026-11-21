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
// KV namespace binding:
//   DUO_KV               stores Duo message counts and the Game Hub projects

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
    'Access-Control-Allow-Headers': 'content-type, x-duo-owner',
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
    created: p.created, updated: p.updated, size: p.size, thumbType: p.thumbType
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
        if (!owner && !sameSecret(await sha256(given), entry.keyHash)) {
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
    const allowed = isOwner(request, env) || sameSecret(await sha256(cleanText(body.editKey, 100)), entry.keyHash);
    if (!allowed) return json(403, {error: 'Only the person who published this project can remove it.'}, cors);
    index.splice(index.indexOf(entry), 1);
    await writeIndex(env, index);
    await Promise.all([env.DUO_KV.delete(`hub:file:${id}`), env.DUO_KV.delete(`hub:thumb:${id}`)]);
    return json(200, {ok: true}, cors);
};

// ---------------------------------------------------------------- router

export default {
    async fetch (request, env) {
        const origin = request.headers.get('Origin') || '';
        const cors = corsHeaders(origin);
        if (request.method === 'OPTIONS') return new Response(null, {status: 204, headers: cors});
        const url = new URL(request.url);
        const path = url.pathname.replace(/\/+$/, '');

        // Reading the Game Hub is open to everyone.
        if (request.method === 'GET') {
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
        return json(404, {error: 'Not found'}, cors);
    }
};
