# Stick Lab Duo server

Stick Lab Duo talks to Claude Opus 5.5 through this small Cloudflare Worker, so your Anthropic
API key is never in the website's code. Each person gets DAILY_LIMIT free messages a day (default 10),
everyone together gets GLOBAL_DAILY_LIMIT a day (default 200), and a device with your owner pass has no limit.

## Set it up (about 10 minutes)

You need a free Cloudflare account and an Anthropic API key (console.anthropic.com, with credit).

1. Install Node.js, then in this folder run:
   `npx wrangler login`
2. Make the storage for daily counts:
   `npx wrangler kv namespace create DUO_KV`
   Paste the `id` it prints into `wrangler.toml` (replace PASTE_THE_KV_ID_HERE).
3. Add your secrets (you'll be asked to paste each one):
   `npx wrangler secret put ANTHROPIC_API_KEY`
   `npx wrangler secret put OWNER_PASS`   (make up a long secret phrase)
4. Publish it:
   `npx wrangler deploy`
   It prints an address like `https://stick-lab-duo.YOURNAME.workers.dev`.
5. Put that address in `lab/duo-config.json` on the website:
   `{ "serverUrl": "https://stick-lab-duo.YOURNAME.workers.dev" }`
6. On your own device, open Stick Lab, click Duo, then the gear, and type your owner pass.

Change `DAILY_LIMIT` (per person) or `GLOBAL_DAILY_LIMIT` (everyone together) in `wrangler.toml` and deploy again,
or edit them in the Cloudflare dashboard under Settings -> Variables and Secrets.
At about $0.03-0.05 per message, 200 messages a day is roughly $6-10 a day at most.
Every message is billed to your Anthropic account, so set a monthly spend limit in the Anthropic console.
