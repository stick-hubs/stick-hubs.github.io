// Stick Lab Duo server: a Cloudflare Worker that talks to Claude Opus 5.5 for Stick Lab.
//
// Secrets (set with `npx wrangler secret put NAME` or in the Cloudflare dashboard):
//   ANTHROPIC_API_KEY  your Anthropic API key (never put it in the website's code)
//   OWNER_PASS         a long secret phrase; a device that sends it has no daily limit
// Variables (wrangler.toml [vars]):
//   DAILY_LIMIT        messages per person per day for everyone else (default 10)
//   GLOBAL_DAILY_LIMIT messages per day for everyone together, so the bill can't run away (default 200)
// KV namespace binding:
//   DUO_KV             stores each person's message count for the day

const MODEL = 'claude-opus-5-5';
const MAX_TOKENS = 2048;
const MAX_MESSAGES = 40;
const MAX_CHARS = 60000;

const ALLOWED_ORIGINS = [
    'https://stick-hubs.github.io',
    'https://app.stick-lab.local', // the Stick Lab desktop app
    'http://localhost:8765'
];

const corsHeaders = origin => ({
    'Access-Control-Allow-Origin': ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0],
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'content-type, x-duo-owner',
    'Access-Control-Expose-Headers': 'x-duo-remaining, x-duo-limit',
    'Vary': 'Origin'
});

const json = (status, body, headers) => new Response(JSON.stringify(body), {
    status,
    headers: {'content-type': 'application/json', ...headers}
});

// Constant-time comparison so the owner pass can't be guessed by timing.
const sameSecret = (a, b) => {
    if (typeof a !== 'string' || typeof b !== 'string' || !b) return false;
    let diff = a.length ^ b.length;
    for (let i = 0; i < Math.max(a.length, b.length); i++) {
        diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
    }
    return diff === 0;
};

const validMessages = messages => Array.isArray(messages) && messages.length > 0 &&
    messages.length <= MAX_MESSAGES &&
    messages.every(m => (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string') &&
    messages[messages.length - 1].role === 'user' &&
    messages.reduce((n, m) => n + m.content.length, 0) <= MAX_CHARS;

export default {
    async fetch (request, env) {
        const origin = request.headers.get('Origin') || '';
        const cors = corsHeaders(origin);
        if (request.method === 'OPTIONS') return new Response(null, {status: 204, headers: cors});
        const url = new URL(request.url);
        if (request.method !== 'POST' || url.pathname !== '/chat') {
            return json(404, {error: 'Not found'}, cors);
        }
        if (!ALLOWED_ORIGINS.includes(origin)) {
            return json(403, {error: 'Stick Lab Duo only works inside Stick Lab.'}, cors);
        }
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
        const isOwner = sameSecret(request.headers.get('x-duo-owner') || '', env.OWNER_PASS || '');
        const limit = Math.max(1, parseInt(env.DAILY_LIMIT || '10', 10));
        const globalLimit = Math.max(1, parseInt(env.GLOBAL_DAILY_LIMIT || '200', 10));
        let remaining = 'unlimited';
        if (!isOwner) {
            const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
            const day = new Date().toISOString().slice(0, 10);
            const key = `count:${day}:${ip}`;
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
                system: typeof body.system === 'string' ? body.system.slice(0, 20000) : undefined,
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
                'x-duo-limit': isOwner ? 'unlimited' : String(limit)
            }
        });
    }
};
