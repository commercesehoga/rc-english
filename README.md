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
add a route on your domain (this project is deployed on `english.thunderstudy.indevs.in`) the
same way you've routed your other tools.

## New: streaks, mistake review, Telegram sign-in, PDF score, weekly topic sets

- **Streaks & mistake review** are 100% client-side (`public/progress.js`, `localStorage`) — no
  extra setup needed. A day counts as "done" once all 3 categories (Grammar, Vocabulary, RC) are
  fully answered that day. The Weekly Test now stays locked on Sunday unless the visitor has
  completed at least **5 days** that week — tune this via `MIN_STREAK_FOR_TEST` in `progress.js`.
- **PDF score card** on the weekly test uses jsPDF from a CDN (`weekly-test.html`) — no build step,
  no secret needed.
- **Sign in with Telegram** and pushing the score PDF to your bot **does** need setup:
  1. Message [@BotFather](https://t.me/BotFather) → `/setdomain` → pick `Tiny_english_robot` →
     enter the exact domain you deploy to (`english.thunderstudy.indevs.in`). The Login Widget
     will refuse to render on any domain that isn't whitelisted here.
  2. Set the bot token as a Worker secret — **never commit it to the repo or paste it into any
     file**, it grants full control of the bot:
     ```bash
     npx wrangler secret put TELEGRAM_BOT_TOKEN
     # paste the token you got from @BotFather when prompted
     ```
  3. Apply the updated schema (adds a `users` table) if you haven't already:
     ```bash
     npx wrangler d1 execute wondermayank-rc-db --remote --file=./schema.sql
     ```
  Note: Telegram's Login Widget only ever needs the one bot token — there's no separate
  client id/secret pair like OAuth providers use, so if you were given anything else labeled
  "client secret", it isn't needed here.
- **The bot itself (interactive commands)** runs in the same Worker, no separate host needed —
  see `handleTelegramWebhook` in `worker/index.js`. It answers `/start`, `/today`, `/week`, and
  `/help`. One-time setup after deploying:
  1. Pick any random string as a webhook secret and store it (this stops randoms from POSTing
     fake updates at your bot — only Telegram will know this value):
     ```bash
     npx wrangler secret put TELEGRAM_WEBHOOK_SECRET
     ```
  2. `SITE_URL` near the top of `worker/index.js` is already set to
     `https://english.thunderstudy.indevs.in` — update it there if the domain ever changes,
     then deploy.
  3. Tell Telegram where to send updates (fill in your bot token, deploy URL, and the same
     secret from step 1):
     ```bash
     curl "https://api.telegram.org/bot<TELEGRAM_BOT_TOKEN>/setWebhook?url=<SITE_URL>/api/telegram/webhook&secret_token=<TELEGRAM_WEBHOOK_SECRET>"
     ```
  4. Confirm it's registered: `curl "https://api.telegram.org/bot<TELEGRAM_BOT_TOKEN>/getWebhookInfo"`
     — `last_error_message` should be empty.
  Message your bot `/start` on Telegram afterwards to confirm it replies.
- **Weekly 10-question topic set** (homepage) pulls 10 random questions from the full D1 archive
  matching up to 10 chosen topics — no new schema needed, it reuses `topic_tag` on
  `daily_content`. Gated to once per Mon–Sun week via `localStorage`, same as streaks.

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

## New (this round): sync, retry mode, archive search, leaderboard, PWA, push bot, Telegram login

### 1. Apply the v2 schema migration first

Everything below (progress sync, leaderboard dedupe, login codes, bot summary columns) needs
new columns/tables. Run this once, after `schema.sql`:

```bash
npx wrangler d1 execute wondermayank-rc-db --remote --file=./schema_v2.sql
```

### 2. Cross-device progress sync

No new secret needed. Signed-in users' whole `localStorage` blob (streak days, mistakes,
custom-practice weeks, weekly-test results) is mirrored to the new `user_progress` D1 table via
`POST /api/progress/sync` and pulled back with `GET /api/progress/:telegram_id`. `progress.js`
calls this automatically (debounced ~1.2s after any change) whenever someone is signed in with
Telegram — anonymous visitors stay 100% local, same as before.

### 3. Review Mistakes → real retry mode with basic spaced repetition

`mistakes.html` now has a **"Retry These"** button that re-quizzes only the mistakes currently
due. Each saved mistake carries a `dueDate`/`interval`: get it right on a retry and the interval
doubles (so it resurfaces further out each time, capped at 30 days); get it wrong and it resets
to due-again-tomorrow. After 3 clean retries in a row it's considered mastered and drops off the
list. All of this lives in `progress.js` (`getDueMistakes`, `recordMistakeRetry`) — no backend
change.

### 4. Passage archive filter/search

`practice.html` now shows topic pills (per category — e.g. inference/tone/theme/detail for RC)
plus a keyword search box above the day navigator. Both hit the new
`GET /api/archive/search?category=&topic=&q=` endpoint and jump straight to the matching day.

### 5. Weekly leaderboard — stored in a Google Sheet, opt-in

Scores never touch a paid database — a tiny **Google Apps Script Web App** acts as the sheet's
API. Set it up once:

1. Create a new Google Sheet. Extensions → Apps Script, paste:

    ```javascript
    function doPost(e) {
      const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName('Sheet1');
      const p = e.parameter;
      if (p.secret !== 'PUT_A_LONG_RANDOM_SECRET_HERE') return ContentService.createTextOutput('forbidden');
      sheet.appendRow([p.telegram_id, p.week_start, p.pct, p.first_name, new Date()]);
      return ContentService.createTextOutput('ok');
    }

    function doGet(e) {
      if (e.parameter.secret !== 'PUT_A_LONG_RANDOM_SECRET_HERE') {
        return ContentService.createTextOutput(JSON.stringify({ rows: [] })).setMimeType(ContentService.MimeType.JSON);
      }
      const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName('Sheet1');
      const data = sheet.getDataRange().getValues();
      const rows = data.map(r => ({ telegram_id: r[0], week_start: r[1], pct: r[2], first_name: r[3] }));
      return ContentService.createTextOutput(JSON.stringify({ rows })).setMimeType(ContentService.MimeType.JSON);
    }
    ```

2. Use the **same random secret** in both places above.
3. Deploy → **New deployment** → type **Web app** → execute as **Me** → access **Anyone**.
   Copy the deployment URL.
4. Set two Worker secrets:
    ```bash
    npx wrangler secret put GOOGLE_SHEET_WEBAPP_URL   # the Web App URL from step 3
    npx wrangler secret put GOOGLE_SHEET_SECRET        # the same secret from step 1/2
    ```

If these two secrets are never set, the leaderboard silently no-ops (checkbox still shows, just
does nothing) — the rest of the site is unaffected.

Known limitation: the leaderboard is opt-in but not retractable — once a score is submitted to
the sheet, un-checking the box on a later visit won't delete the row (delete it manually in the
Sheet if needed).

### 6. Installable (PWA)

`public/manifest.json` + `public/sw.js` + `public/pwa.js` (registers the worker) are wired into
every page. The service worker caches the static shell and network-first-caches
`/api/today`/`/api/days` so a brief offline moment still shows the last-loaded content. No setup
needed — it just works once deployed over HTTPS.

One thing worth doing yourself: the manifest currently points at `favicon.svg` for icons. SVG
icons render fine on Chrome/Edge/Android, but for the best iOS "Add to Home Screen" look, export
dedicated 192×192 and 512×512 PNGs (from `book.png` or a simplified mark) and add them to the
`icons` array in `manifest.json`.

### 7. Build Your Own set — now 10–50 questions, plus your own topics

`index.html`'s topic picker now has a question-count `<select>` (10/20/30/40/50) and a free-text
"Add your own topic" input, capped at 10 topics total (checklist + custom combined). The backend
(`getCustomPractice` in `worker/index.js`) matches free-typed topics loosely against `topic_tag`
and question text (`LIKE`), so something like "idioms" still finds "Idioms & Phrases" questions.

### 8. Telegram bot — push notifications, quiz polls, inactivity nudges, command parity

All of this runs off the existing daily cron (`runDailyCron` in `worker/index.js`) — no new
trigger needed:

- **Proactive push**: every opted-in user (anyone who hasn't sent `/stop`) gets a "today's set is
  ready" message right after the cron generates content — no more waiting for someone to ask
  `/today`. On Sundays it also mentions the newly-unlocked Weekly Test (that reminder **only**
  ever goes out via Telegram, never as a website popup).
- **Native quiz polls**: a random Grammar/Vocabulary question goes out daily as a Telegram
  `sendPoll` quiz (`type: "quiz"`) — answerable right in the chat, no browser needed.
- **Inactivity nudges**: anyone who's practiced before but has gone quiet for 2+ days gets a
  gentle "you're about to lose your streak" ping, once per day at most.
- **Auto-send weekly scorecard**: the moment someone finishes the Sunday test, the PDF score card
  is sent to their Telegram automatically (`weekly-test.html` calls the existing
  `/api/telegram/send-pdf` right after grading — "Send to Telegram" is now just a manual fallback).
- **Command parity**: `/mistakes` (open-mistake count) and `/streak` (current + best streak) join
  the existing `/today`, `/week`, `/help`, `/start`. `/stop` pauses all daily/weekly pushes.
  Note: `/mistakes` and `/streak` read from the `users` table, which is only populated once
  someone has signed in with Telegram **and** synced at least once from the website — a purely
  anonymous (never-signed-in) Telegram chat won't have this data yet.

No extra secrets needed beyond the `TELEGRAM_BOT_TOKEN`/`TELEGRAM_WEBHOOK_SECRET` already set up
in the previous round.

### 9. Telegram login — KV-backed one-time tokens, real popup, no widget quirks

Two ways to sign in, both without the flaky Telegram Login Widget:

- **"Continue in browser"** redirects straight to Telegram's real OAuth page
  (`oauth.telegram.org/auth`), opened as a genuine small **popup window** (not a new tab) — this
  is the same mechanism the official widget uses under the hood, just without embedding
  `telegram-widget.js`. Requires `/setdomain` on @BotFather to be set to your exact deploy domain
  (see the "Sign in with Telegram" setup notes above) — that's the #1 cause of this not working.
- **"Log in from Telegram"** hands you a `t.me/<bot>?start=<token>` link; tapping **Start** inside
  the bot signs you in immediately, and the site (polling in the background) picks it up within
  a couple seconds. Typing plain `/start` *inside the bot itself* now does the same thing — the
  bot replies with a one-tap sign-in link, no separate `/login` command needed.

**Setup — create the KV namespace this relies on:**

```bash
npx wrangler kv namespace create LOGIN_KV
```

Paste the `id` it prints into `wrangler.toml` under `[[kv_namespaces]]` (replacing
`PASTE_YOUR_KV_NAMESPACE_ID_HERE`), then deploy.

**Why KV instead of D1 for this:** tokens are meant to be short-lived and single-use, and KV's
native TTL does that cleanup for free — no cron, no manual delete queries.

- A token starts **pending** for up to **3 minutes** (time to open the bot and tap Start). If
  never approved, it just falls out of KV on its own.
- Once approved, it flips to **verified** for up to **2 more minutes** (time for the site's poll
  to notice). If the site never picks it up, it also falls out on its own.
- The instant the site's poll successfully reads a verified token, the token is **deleted
  immediately** — so the same link can never complete a second login.

The old D1 `login_requests` table (created by `schema_v2.sql`) is no longer read from — it's
harmless to leave in place, or drop it if you'd rather:
```sql
DROP TABLE IF EXISTS login_requests;
```

## New (this round): quieter /start, tg:// fallback, dedicated Leaderboard page, Install App button

1. **`/start` no longer spams a login link at returning users.** The bot checks `users` for that
   `telegram_id` first — a brand-new chat still gets the welcome message + one-tap sign-in link,
   but anyone already known just gets a plain "Welcome back" + the command list. Their user row is
   always refreshed either way (`upsertUser` runs regardless), so `/streak`/`/mistakes` stay accurate.
2. **"Log in from Telegram" tries `tg://` before `t.me`.** Some ISPs specifically block/throttle
   `t.me`'s DNS (shows as `DNS_PROBE_FINISHED_NXDOMAIN`) even though Telegram itself is reachable.
   The button now first tries handing off to an installed Telegram app via the `tg://resolve`
   custom URI scheme, which never touches `t.me` at all, and only falls back to the normal
   `https://t.me/...` link about 1.2s later if nothing caught it. This isn't a complete fix for a
   network that blocks Telegram entirely (no Telegram app installed + `t.me` blocked = still
   broken) — if you hit that, it's worth testing on mobile data or a VPN to confirm it's a
   network-level block and not a code issue.
3. **Homepage's "Passage Archive" card is now "Weekly Leaderboard".** It links to the new
   `leaderboard.html`, which shows the current week's top scorers (and lets you flip back through
   the last 6 weeks) — same opt-in Google-Sheet-backed data as the result screen on
   `weekly-test.html`. The archive filter/search feature itself hasn't gone anywhere — it's still
   right there on `practice.html?cat=rc` (or grammar/vocab), just no longer promoted as its own
   homepage tile.
4. **Hero's "Explore Topics" button doubles as an Install App prompt.** If the browser fires
   `beforeinstallprompt` (meaning the site is installable and not already installed), the button
   becomes "📲 Install App" and triggers the native install dialog on click. Once installed (or if
   it's already running as an installed app), it reverts to normal "Explore Topics" behavior
   scrolling to the topic grid. No setup needed — this is standard PWA behavior once `manifest.json`
   + `sw.js` are being served over HTTPS (already wired in from the earlier PWA round).

## New (this round): mobile pass

- **Working mobile nav.** Previously the nav links just vanished below 760px with no way back to
  them. `public/nav.js` now injects a hamburger toggle into every page's existing `.navbar`
  markup (no per-page HTML edits needed) — tap it to open a full-width dropdown with all the same
  links. Closes on outside-click, on link-click, and on resize back past 760px.
- **Hero illustration (`book.png`) is gone on mobile** (`≤760px`) — hidden via CSS and also marked
  `loading="lazy"` on the `<img>` itself, so phones don't download it at all, not just hide it.
- A handful of small-screen tightening passes: bigger tap targets for the weekly-test question
  grid and date-nav arrows on mobile, the custom-topic "add" row stacks instead of squeezing on
  very narrow phones (`≤400px`), the Telegram login dropdown can no longer overflow the viewport
  edge on small phones, and `overflow-x: hidden` on `html body` as a safety net against any
  absolutely-positioned menu causing sideways scroll.

No new secrets or migrations — just deploy:
```bash
npx wrangler deploy
```
