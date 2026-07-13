# WonderMayank — RC / Grammar / Vocabulary

Daily AI-generated practice (Groq) stored in Cloudflare D1, with an archive of past days and a
full-week CBT test that unlocks every Sunday.

## Where does this host?

**Everywhere — one place: a single Cloudflare Worker.** There is no separate Cloudflare Pages
project and no separate backend host. `public/` (the frontend) and `worker/index.js` (the API +
cron) deploy together with one `wrangler deploy` (or one Git-connected repo). Cloudflare's
`[assets]` feature in `wrangler.toml` is what makes a single Worker able to serve static files
*and* run backend logic — see step 6 below for both the manual and GitHub-connected ways to do
that deploy.

## How it works

- **Daily generation**: a Cron Trigger fires once a day (00:30 UTC = 6:00 AM IST) and asks Groq
  for 5 Grammar MCQs, 5 Vocabulary MCQs, and 1 RC passage + 5 questions. Everything is written to
  D1. If a visitor hits the site before the cron has run (e.g. day one, or a missed run), `/api/today`
  generates on-demand and caches it — so it's never broken, just occasionally generated a few
  seconds late for the very first visitor of the day.
- **Archive**: every category card and the practice page let you page back through any past date
  stored in D1 — nothing is deleted.
- **Weekly test**: `/api/week/status` reports whether today is Sunday (IST). The "Generate Test"
  button only calls the generate endpoint when it's Sunday — the Worker double-checks server-side
  too, so it can't be triggered early by editing the page. Once generated, the test snapshots that
  week's question IDs (Mon–Sun only) into `weekly_tests`, so it always contains **only that week's
  questions**, and repeat clicks return the same snapshot instead of a new random set.

## 1. Prerequisites

```bash
npm install -g wrangler
wrangler login
```

Get a free Groq API key at [console.groq.com](https://console.groq.com) (no card needed).

## 2. Project files

Copy this whole folder into your repo. Then copy your existing `book.png` into `public/book.png`
— the homepage references it as a relative path (`<img src="book.png">`), so it just needs to sit
next to `index.html`.

```
wondermayank-rc/
├── wrangler.toml
├── schema.sql
├── worker/index.js
└── public/
    ├── index.html
    ├── practice.html
    ├── weekly-test.html
    ├── style.css
    └── book.png   ← copy your existing file here
```

## 3. Create the D1 database

```bash
cd wondermayank-rc
npx wrangler d1 create wondermayank-rc-db
```

This prints a `database_id`. Paste it into `wrangler.toml` under `[[d1_databases]]`.

## 4. Apply the schema

```bash
npx wrangler d1 execute wondermayank-rc-db --remote --file=./schema.sql
```

## 5. Set your Groq key as a secret (never put it in wrangler.toml)

```bash
npx wrangler secret put GROQ_API_KEY
# paste your key when prompted
```

## 6. Deploy

You have two options — pick one. **Option A is simplest if you just want it live now.**
Option B is what you want long-term, since it matches how you already work (push to GitHub → live).

### Option A: deploy straight from your machine

```bash
npx wrangler deploy
```

Wrangler prints your live URL, e.g. `https://wondermayank-rc.<your-subdomain>.workers.dev`.

### Option B: connect this repo to Cloudflare so every push auto-deploys

This whole project — frontend, API, and cron — is **one Worker**, not a separate frontend host
+ backend host. So there's only one thing to connect, once:

1. Push this folder to a new GitHub repo (e.g. `wondermayank-rc`).
2. In the Cloudflare dashboard → **Workers & Pages → Create application → Import a repository**
   (or, if you already ran `wrangler deploy` once from Option A, open that Worker →
   **Settings → Builds → Connect**).
3. Pick the GitHub repo. Cloudflare finds `wrangler.toml` automatically.
4. Build command: leave empty (no bundler/framework here, nothing to build).
   Deploy command: `npx wrangler deploy`.
5. **Important**: the Worker name shown in the Cloudflare dashboard must exactly match the
   `name` field in `wrangler.toml` (`wondermayank-rc`), or the build will fail.
6. Save and deploy. Every `git push` to your production branch from now on redeploys
   automatically, with build logs visible in both the Cloudflare dashboard and as GitHub
   check runs on the commit.

Either way, you still do steps 3–5 above (create D1, apply schema, set the `GROQ_API_KEY`
secret) **once**, manually, before the first deploy — the Git integration builds and deploys
your code, but it doesn't create databases or secrets for you.

## 7. Sanity checks after deploy

```bash
# Force today's content to generate right now instead of waiting for 6 AM IST
curl https://wondermayank-rc.<you>.workers.dev/api/today

# Check week status
curl https://wondermayank-rc.<you>.workers.dev/api/week/status
```

If `/api/today` returns questions, generation + D1 are wired correctly. Open the site in a
browser and click through Grammar / Vocabulary / Reading Comprehension.

## 8. Custom domain (optional)

In the Cloudflare dashboard → Workers & Pages → your Worker → **Settings → Domains & Routes**,
add a route on `wondermayank.in` (or a subdomain like `rc.wondermayank.in`) the same way you've
routed your other tools.

## Notes / limits worth knowing

- **Groq free tier**: 30 requests/min, ~1,000 requests/day per model, no card required. This app
  makes at most 3 Groq calls a day (one per category), so it stays nowhere near the limit even if
  you also use Groq elsewhere.
- **Cron free tier**: Workers Free plan allows up to 5 Cron Triggers per account — this project
  uses 1.
- **Cron always runs in UTC.** `30 0 * * *` = 00:30 UTC = 6:00 AM IST. If you ever want a
  different IST time, recompute the UTC equivalent (IST is UTC+5:30) rather than editing the
  number directly.
- **D1 free tier** comfortably covers this — each day writes 15 rows; a full year is ~5,500 rows.
- To regenerate a specific day manually (e.g. if a Groq call failed mid-way and only 2 of 3
  categories got written), just hit `/api/today` again — it only fills in whatever's missing, it
  never duplicates a category that already exists for that date.
