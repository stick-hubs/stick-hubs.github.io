# Stick Hubs server (Stick Lab Duo + Game Hub)

**Only want the Game Hub (free)?** Skip the ANTHROPIC_API_KEY secret. Publishing works without it, and Duo then uses
each person's own Anthropic API key (set in Duo's settings). Keep `"duo": false` in `lab/duo-config.json`.

This one Cloudflare Worker runs two things: Stick Lab Duo and the Game Hub, where people publish their Stick Lab projects.

Stick Lab Duo talks to Claude Opus 5.5 through this small Cloudflare Worker, so your Anthropic
API key is never in the website's code. Each person gets DAILY_LIMIT free messages a day (default 10),
everyone together gets GLOBAL_DAILY_LIMIT a day (default 200), and a device with your owner pass has no limit.

## Set it up (about 10 minutes)

You need a free Cloudflare account and an Anthropic API key (console.anthropic.com, with credit).

1. Install Node.js, then in this folder run:
   `npx wrangler login`
2. Make the storage for daily counts and Game Hub projects:
   `npx wrangler kv namespace create DUO_KV`
   Paste the `id` it prints into `wrangler.toml` (replace PASTE_THE_KV_ID_HERE).
3. Add your secrets (you'll be asked to paste each one):
   `npx wrangler secret put ANTHROPIC_API_KEY`
   `npx wrangler secret put OWNER_PASS`   (make up a long secret phrase)
4. Publish it:
   `npx wrangler deploy`
   It prints an address like `https://stick-hubs-server.YOURNAME.workers.dev`.
5. Put that address in `lab/duo-config.json` on the website:
   `{ "serverUrl": "https://stick-hubs-server.YOURNAME.workers.dev" }`
6. On your own device, open Stick Lab, click Duo, then the gear, and type your owner pass.

Change `DAILY_LIMIT` (per person) or `GLOBAL_DAILY_LIMIT` (everyone together) in `wrangler.toml` and deploy again,
or edit them in the Cloudflare dashboard under Settings -> Variables and Secrets.
At about $0.03-0.10 per message ("Build a game" answers are the longest), 200 messages a day is roughly $6-20 a day at most.
Every message is billed to your Anthropic account, so set a monthly spend limit in the Anthropic console.

## The Game Hub

The same address also runs the Game Hub, so step 5 above switches on both Duo and publishing.
Nothing else to set up: the Game Hub page (games.html, "Community projects") and the play page (hub-play.html)
read the same `lab/duo-config.json`.

- People press **Publish** in Stick Lab. Each person can publish or update `PUBLISH_DAILY_LIMIT` times a day (default 5).
- Projects can be up to 10 MB. Titles, nicknames and descriptions with blocked words are refused.
- Anyone can press **Report** on a project. After 3 reports from different people it is hidden from the list.
- The device that published a project can update it or remove it (Stick Lab keeps a secret edit key on that device).
- **You can remove any project:** with your owner pass saved in Duo settings on your device, open the project's play page,
  press About, then "Remove from the Game Hub".

Cloudflare's free plan allows 1,000 storage writes a day. Each publish uses about 4 and each Duo message 2,
so the free plan covers roughly 100 publishes and 300 Duo messages a day. The paid Workers plan ($5 a month) raises this a lot.

## Accounts (sign in with GitHub)

Accounts are free too. They need a GitHub "OAuth App" so people can sign in with GitHub:

1. On GitHub, go to Settings -> Developer settings -> OAuth Apps -> New OAuth App.
2. Application name: `Stick Hubs`. Homepage URL: `https://stick-hubs.github.io`.
   Authorization callback URL: your server address + `/auth/callback`,
   for example `https://stick-hubs-server.YOURNAME.workers.dev/auth/callback`.
3. Click Register application. Copy the **Client ID**, then click "Generate a new client secret" and copy the secret.
4. In Cloudflare, on your Worker: Settings -> Variables and Secrets -> Add:
   - type Text, name `GITHUB_CLIENT_ID`, value: the Client ID
   - type Secret, name `GITHUB_CLIENT_SECRET`, value: the client secret
   Then Deploy.

Stick Hubs only reads each person's public GitHub username and picture (no email, no repositories).
Profiles are public. Anyone can report a profile; after 3 reports its pictures, name and bio are removed.
With your owner pass saved in Duo settings on your device, the profile page shows "Owner: reset this profile".


## Friends and chat (D1 database)

Friends and chat keep their data in a free Cloudflare D1 database, because KV only allows about 1,000 writes a day on the free plan.

1. In the Cloudflare dashboard go to **Storage & databases > D1 SQL Database > Create**, and name it `stick-hubs-friends`.
2. Open the Worker, then **Settings > Bindings > Add binding > D1 database**. Variable name: `SH_DB`, database: `stick-hubs-friends`.
3. Deploy. The tables are made automatically the first time someone opens the Friends page.

Reported chat messages: send a POST to `/owner/reports` with the header `x-duo-owner: <OWNER_PASS>`.
