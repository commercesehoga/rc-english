// WonderMayank RC / Grammar / Vocabulary — Cloudflare Worker
// Handles: daily question generation (Groq), D1 storage, archive lookup, weekly Sunday CBT test,
// cross-device progress sync, Google-Sheet-backed weekly leaderboard, and the Telegram bot
// (push notifications, quiz polls, inactivity nudges, Telegram deep-link sign-in).

const GROQ_MODEL = "llama-3.3-70b-versatile";
const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;

// Used inside the Telegram bot's replies (/start, /today, /week) and push notifications.
// Update this if/when you put the app on a custom domain (Settings → Domains & Routes).
const SITE_URL = "https://english.thunderstudy.indevs.in";

// Public @username of the bot (no @, no https://t.me/) — used to build t.me?start= deep links
// for the new "log in from inside Telegram" flow.
const BOT_USERNAME = "Tiny_english_robot";

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname.startsWith("/api/")) {
      return handleApi(request, env, url);
    }
    // Static files are matched before the Worker runs (see [assets] in wrangler.toml).
    // Anything reaching here has no matching file — hand it to ASSETS for the 404 page.
    return env.ASSETS.fetch(request);
  },

  // Cron trigger — see [triggers] in wrangler.toml (runs once daily, ~6 AM IST).
  async scheduled(controller, env, ctx) {
    ctx.waitUntil(runDailyCron(env, getISTDateString()));
  },
};

// Generates the day's content, then pushes it out (proactive "today's set is ready" message +
// a quiz poll + the Sunday weekly-test nudge) and checks for anyone who's gone quiet.
// Each step is independently try/caught downstream so one failure never blocks the others.
async function runDailyCron(env, date) {
  await generateDailyContent(env, date);
  await pushMorningNotifications(env, date);
  await sendInactivityNudges(env, date);
}

// ---------- routing ----------

async function handleApi(request, env, url) {
  const headers = corsHeaders();
  if (request.method === "OPTIONS") return new Response(null, { headers });

  try {
    const { pathname } = url;

    if (pathname === "/api/today" && request.method === "GET") {
      return json(await getOrGenerateToday(env), headers);
    }

    if (pathname === "/api/days" && request.method === "GET") {
      return json(await listAvailableDays(env), headers);
    }

    const dayMatch = pathname.match(/^\/api\/day\/(\d{4}-\d{2}-\d{2})$/);
    if (dayMatch && request.method === "GET") {
      return json(await getDay(env, dayMatch[1]), headers);
    }

    if (pathname === "/api/week/status" && request.method === "GET") {
      return json(await getWeekStatus(env), headers);
    }

    if (pathname === "/api/week/generate" && request.method === "POST") {
      return json(await generateWeeklyTest(env), headers);
    }

    const weekMatch = pathname.match(/^\/api\/week\/(\d{4}-\d{2}-\d{2})$/);
    if (weekMatch && request.method === "GET") {
      return json(await getWeeklyTest(env, weekMatch[1]), headers);
    }

    if (pathname === "/api/practice/custom" && request.method === "GET") {
      const topics = (url.searchParams.get("topics") || "")
        .split(",")
        .map((t) => t.trim())
        .filter(Boolean)
        .slice(0, 10);
      const count = url.searchParams.get("count");
      return json(await getCustomPractice(env, topics, count), headers);
    }

    // Passage archive filter/search — jump straight to a day by topic (inference/tone/theme/
    // detail/etc.) or a keyword, instead of paging back one day at a time.
    if (pathname === "/api/archive/search" && request.method === "GET") {
      return json(
        await searchArchive(env, {
          category: url.searchParams.get("category") || "rc",
          topic: url.searchParams.get("topic") || "",
          q: url.searchParams.get("q") || "",
        }),
        headers
      );
    }

    if (pathname === "/api/progress/sync" && request.method === "POST") {
      return json(await handleProgressSync(env, request), headers);
    }

    const progressMatch = pathname.match(/^\/api\/progress\/(\d+)$/);
    if (progressMatch && request.method === "GET") {
      return json(await handleProgressGet(env, progressMatch[1]), headers);
    }

    if (pathname === "/api/leaderboard/submit" && request.method === "POST") {
      return json(await handleLeaderboardSubmit(env, request), headers);
    }

    const lbMatch = pathname.match(/^\/api\/leaderboard\/(\d{4}-\d{2}-\d{2})$/);
    if (lbMatch && request.method === "GET") {
      return json(await fetchLeaderboard(env, lbMatch[1]), headers);
    }

    // "Log in from inside Telegram" — the site creates a code, the person approves it either
    // via the t.me?start= deep link (tapping Start in the bot claims it), and the site polls
    // this status endpoint until it's claimed. No Telegram Login Widget popup needed.
    if (pathname === "/api/login/start" && request.method === "POST") {
      return json(await handleLoginStart(env), headers);
    }

    const loginStatusMatch = pathname.match(/^\/api\/login\/status\/([a-zA-Z0-9]+)$/);
    if (loginStatusMatch && request.method === "GET") {
      return json(await handleLoginStatus(env, loginStatusMatch[1]), headers);
    }

    if (pathname === "/api/auth/telegram" && request.method === "POST") {
      return json(await handleTelegramAuth(env, request), headers);
    }

    // NOTE: this used to hand-roll a redirect straight to oauth.telegram.org (reverse-engineered
    // from what the official widget does internally). Replaced with Telegram's actual documented
    // Login Widget (telegram-widget.js + data-onauth callback, see index.html) per
    // https://core.telegram.org/widgets/login — Telegram's own script manages the popup/auth
    // flow itself now, so this endpoint isn't needed anymore.
    if (pathname === "/api/telegram/notify" && request.method === "POST") {
      return json(await handleTelegramNotify(env, request), headers);
    }

    if (pathname === "/api/telegram/send-pdf" && request.method === "POST") {
      return json(await handleTelegramSendPdf(env, request), headers);
    }

    // Telegram calls this directly (server-to-server) once you register it with setWebhook —
    // see the setup notes above handleTelegramWebhook below. Not part of the JSON API, so it
    // returns its own plain-text response instead of going through json().
    if (pathname === "/api/telegram/webhook" && request.method === "POST") {
      return handleTelegramWebhook(env, request);
    }

    return json({ error: "Not found" }, headers, 404);
  } catch (err) {
    return json({ error: err.message || "Server error" }, headers, 500);
  }
}

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Content-Type": "application/json",
  };
}

function json(obj, headers, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers });
}

// ---------- IST date helpers (Cron + Date always run in UTC on Workers) ----------

function getISTDateString(baseDate) {
  const d = baseDate ? new Date(baseDate) : new Date();
  const ist = new Date(d.getTime() + IST_OFFSET_MS);
  return ist.toISOString().slice(0, 10); // YYYY-MM-DD
}

function getISTDayOfWeek(baseDate) {
  const d = baseDate ? new Date(baseDate) : new Date();
  const ist = new Date(d.getTime() + IST_OFFSET_MS);
  return ist.getUTCDay(); // 0 = Sunday ... 6 = Saturday
}

// Monday–Sunday bounds for the IST week containing dateStr (YYYY-MM-DD)
function getWeekBounds(dateStr) {
  const d = new Date(dateStr + "T00:00:00Z");
  const day = d.getUTCDay();
  const diffToMonday = day === 0 ? -6 : 1 - day;
  const monday = new Date(d);
  monday.setUTCDate(d.getUTCDate() + diffToMonday);
  const sunday = new Date(monday);
  sunday.setUTCDate(monday.getUTCDate() + 6);
  return {
    start: monday.toISOString().slice(0, 10),
    end: sunday.toISOString().slice(0, 10),
  };
}

// ---------- Groq generation ----------

async function callGroq(env, systemPrompt, userPrompt) {
  const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${env.GROQ_API_KEY}`,
    },
    body: JSON.stringify({
      model: GROQ_MODEL,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
      temperature: 0.85,
      response_format: { type: "json_object" },
    }),
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Groq error ${res.status}: ${errText.slice(0, 300)}`);
  }

  const data = await res.json();
  let raw = data.choices?.[0]?.message?.content || "{}";
  raw = raw.trim().replace(/^```json\s*/i, "").replace(/^```\s*/i, "").replace(/```$/i, "");
  return JSON.parse(raw);
}

const JSON_SHAPE = `Return strict JSON only, no markdown, no commentary, in exactly this shape:
{
  "questions": [
    {
      "question": "string",
      "options": {"a": "string", "b": "string", "c": "string", "d": "string"},
      "correct": "a",
      "explanation": "one or two sentence explanation",
      "topic": "short topic label",
      "difficulty": "easy|medium|hard"
    }
  ]
}
Exactly 5 items in the questions array. Exactly one correct option per question.`;

function grammarPrompt(dateStr) {
  return {
    system:
      "You are an expert English grammar question setter for Indian competitive exams (SSC, CUET, Banking, CAT level). Always respond with strict JSON only.",
    user: `Generate exactly 5 unique multiple-choice English grammar questions for ${dateStr}. Mix difficulty from easy to hard, and rotate across these topics so all 5 aren't the same one: Parts of Speech, Tenses, Subject-Verb Agreement, Active & Passive Voice, Direct & Indirect Speech, Articles & Prepositions, Error Spotting.\n\n${JSON_SHAPE}`,
  };
}

function vocabPrompt(dateStr) {
  return {
    system:
      "You are an expert English vocabulary question setter for Indian competitive exams. Always respond with strict JSON only.",
    user: `Generate exactly 5 unique multiple-choice English vocabulary questions for ${dateStr}. Mix difficulty from easy to hard, and rotate across these topics: Synonyms, Antonyms, Idioms & Phrases, One-Word Substitution, Spelling Correction.\n\n${JSON_SHAPE}`,
  };
}

function rcPrompt(dateStr) {
  return {
    system:
      "You are an expert Reading Comprehension question setter for Indian competitive exams. Always respond with strict JSON only.",
    user: `Write one original reading comprehension passage (160-220 words, exam style, any theme — science, economy, history, society) for ${dateStr}. The passage must be original, not copied from any existing book, article or exam. Then write exactly 5 multiple-choice questions testing inference, tone, theme/main idea, vocabulary-in-context, and one factual detail.\n\nReturn strict JSON only, in exactly this shape:\n{\n  "passage": "string",\n  "questions": [\n    {\n      "question": "string",\n      "options": {"a": "string", "b": "string", "c": "string", "d": "string"},\n      "correct": "a",\n      "explanation": "one or two sentence explanation",\n      "topic": "inference|tone|theme|vocabulary|detail",\n      "difficulty": "easy|medium|hard"\n    }\n  ]\n}\nExactly 5 items in the questions array.`,
  };
}

async function insertCategory(env, date, category, passage, questions) {
  const stmt = env.DB.prepare(
    `INSERT INTO daily_content (date, category, passage, question, option_a, option_b, option_c, option_d, correct_option, explanation, topic_tag, difficulty)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  const batch = questions.map((q) =>
    stmt.bind(
      date,
      category,
      passage || null,
      q.question,
      q.options.a,
      q.options.b,
      q.options.c,
      q.options.d,
      q.correct,
      q.explanation || "",
      q.topic || "",
      q.difficulty || "medium"
    )
  );
  await env.DB.batch(batch);
}

// Fills in whichever of grammar / vocabulary / rc are missing for a date.
// Safe to call repeatedly — never regenerates a category that already exists.
async function generateDailyContent(env, dateStr) {
  const date = dateStr || getISTDateString();
  const existing = await env.DB.prepare(`SELECT DISTINCT category FROM daily_content WHERE date = ?`)
    .bind(date)
    .all();
  const have = new Set((existing.results || []).map((r) => r.category));

  if (!have.has("grammar")) {
    const { system, user } = grammarPrompt(date);
    const data = await callGroq(env, system, user);
    await insertCategory(env, date, "grammar", null, data.questions);
  }
  if (!have.has("vocabulary")) {
    const { system, user } = vocabPrompt(date);
    const data = await callGroq(env, system, user);
    await insertCategory(env, date, "vocabulary", null, data.questions);
  }
  if (!have.has("rc")) {
    const { system, user } = rcPrompt(date);
    const data = await callGroq(env, system, user);
    await insertCategory(env, date, "rc", data.passage, data.questions);
  }
}

// ---------- reads ----------

async function getOrGenerateToday(env) {
  const date = getISTDateString();
  // Cron should already have generated today's set at 6 AM IST — this is the fallback
  // for the first-ever visit, or if the cron run failed for some reason.
  await generateDailyContent(env, date);
  return getDay(env, date);
}

async function getDay(env, date) {
  const rows = await env.DB.prepare(
    `SELECT id, category, passage, question, option_a, option_b, option_c, option_d, correct_option, explanation, topic_tag, difficulty
     FROM daily_content WHERE date = ? ORDER BY category, id`
  )
    .bind(date)
    .all();

  const grouped = { date, grammar: [], vocabulary: [], rc: { passage: null, questions: [] } };
  for (const r of rows.results || []) {
    const item = {
      id: r.id,
      question: r.question,
      options: { a: r.option_a, b: r.option_b, c: r.option_c, d: r.option_d },
      correct: r.correct_option,
      explanation: r.explanation,
      topic: r.topic_tag,
      difficulty: r.difficulty,
    };
    if (r.category === "rc") {
      grouped.rc.passage = r.passage;
      grouped.rc.questions.push(item);
    } else if (grouped[r.category]) {
      grouped[r.category].push(item);
    }
  }
  return grouped;
}

async function listAvailableDays(env) {
  const rows = await env.DB.prepare(
    `SELECT date, COUNT(*) as count FROM daily_content GROUP BY date ORDER BY date DESC LIMIT 60`
  ).all();
  return { days: (rows.results || []).map((r) => ({ date: r.date, count: r.count })) };
}

// ---------- passage archive filter/search ----------
// Lets someone jump straight to a past day by topic (inference/tone/theme/detail/vocabulary)
// or a keyword, instead of paging back through the archive one day at a time.
async function searchArchive(env, { category, topic, q }) {
  const cat = category || "rc";
  let sql = `SELECT date, topic_tag, passage, question FROM daily_content WHERE category = ?`;
  const params = [cat];
  if (topic) {
    sql += ` AND topic_tag = ?`;
    params.push(topic);
  }
  if (q) {
    sql += ` AND (passage LIKE ? OR question LIKE ?)`;
    params.push(`%${q}%`, `%${q}%`);
  }
  sql += ` ORDER BY date DESC LIMIT 60`;

  const rows = await env.DB.prepare(sql).bind(...params).all();
  const byDate = new Map();
  for (const r of rows.results || []) {
    if (!byDate.has(r.date)) {
      byDate.set(r.date, { date: r.date, topics: new Set(), snippet: (r.passage || r.question || "").slice(0, 160) });
    }
    if (r.topic_tag) byDate.get(r.date).topics.add(r.topic_tag);
  }
  return {
    results: [...byDate.values()].map((d) => ({ date: d.date, topics: [...d.topics], snippet: d.snippet })),
  };
}

// ---------- weekly Sunday CBT test ----------

async function getWeekStatus(env) {
  const today = getISTDateString();
  const dow = getISTDayOfWeek();
  const { start, end } = getWeekBounds(today);

  const existingTest = await env.DB.prepare(`SELECT id, generated_at FROM weekly_tests WHERE week_start = ?`)
    .bind(start)
    .first();
  const countRow = await env.DB.prepare(`SELECT COUNT(*) as c FROM daily_content WHERE date BETWEEN ? AND ?`)
    .bind(start, end)
    .first();

  return {
    today,
    isSunday: dow === 0,
    weekStart: start,
    weekEnd: end,
    questionsThisWeek: countRow?.c || 0,
    testGenerated: !!existingTest,
  };
}

async function generateWeeklyTest(env) {
  const today = getISTDateString();
  const dow = getISTDayOfWeek();
  if (dow !== 0) {
    throw new Error("The weekly test only unlocks on Sunday (IST).");
  }
  const { start, end } = getWeekBounds(today);

  const existing = await env.DB.prepare(`SELECT question_ids FROM weekly_tests WHERE week_start = ?`)
    .bind(start)
    .first();
  if (existing) {
    return buildWeeklyTestPayload(env, start, end, JSON.parse(existing.question_ids));
  }

  const rows = await env.DB.prepare(`SELECT id FROM daily_content WHERE date BETWEEN ? AND ?`)
    .bind(start, end)
    .all();
  const ids = (rows.results || []).map((r) => r.id);
  if (ids.length === 0) {
    throw new Error("No questions generated for this week yet.");
  }

  // Fisher–Yates shuffle, snapshotted once so retakes see the same order.
  for (let i = ids.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [ids[i], ids[j]] = [ids[j], ids[i]];
  }

  await env.DB.prepare(`INSERT INTO weekly_tests (week_start, week_end, question_ids) VALUES (?, ?, ?)`)
    .bind(start, end, JSON.stringify(ids))
    .run();

  return buildWeeklyTestPayload(env, start, end, ids);
}

async function getWeeklyTest(env, weekStart) {
  const existing = await env.DB.prepare(`SELECT week_end, question_ids FROM weekly_tests WHERE week_start = ?`)
    .bind(weekStart)
    .first();
  if (!existing) throw new Error("No test found for that week.");
  return buildWeeklyTestPayload(env, weekStart, existing.week_end, JSON.parse(existing.question_ids));
}

// ---------- weekly topic-picker practice (up to 10 topics, 10-50 questions, pulled from the full archive) ----------
// Topics can be exact tags from the fixed checklist (Tenses, Synonyms, inference, ...) or a
// free-text topic the person typed themselves — matched loosely against topic_tag/question text
// so a typed word like "idioms" still finds "Idioms & Phrases" questions.

async function getCustomPractice(env, topics, countParam) {
  if (!topics.length) throw new Error("Select at least one topic.");
  const count = Math.min(Math.max(parseInt(countParam, 10) || 10, 10), 50);
  const conditions = topics.map(() => `(topic_tag = ? OR topic_tag LIKE ? OR question LIKE ?)`).join(" OR ");
  const params = [];
  topics.forEach((t) => params.push(t, `%${t}%`, `%${t}%`));
  const rows = await env.DB.prepare(
    `SELECT id, category, passage, question, option_a, option_b, option_c, option_d, correct_option, explanation, topic_tag, difficulty, date
     FROM daily_content WHERE ${conditions} ORDER BY RANDOM() LIMIT ?`
  )
    .bind(...params, count)
    .all();

  const questions = (rows.results || []).map((r) => ({
    id: r.id,
    date: r.date,
    category: r.category,
    passage: r.category === "rc" ? r.passage : null,
    question: r.question,
    options: { a: r.option_a, b: r.option_b, c: r.option_c, d: r.option_d },
    correct: r.correct_option,
    explanation: r.explanation,
    topic: r.topic_tag,
    difficulty: r.difficulty,
  }));

  if (!questions.length) {
    throw new Error("No archived questions match those topics yet — check back after a few more days of content.");
  }
  return { topics, totalQuestions: questions.length, questions };
}

// ---------- cross-device progress sync ----------
// The client's whole localStorage blob (completed days, mistakes, custom-practice weeks,
// weekly-test results) is mirrored here keyed by telegram_id, and also condensed into a few
// summary columns on `users` so the bot's /streak and /mistakes commands don't need to touch
// the full blob.

function addDaysStr(dateStr, n) {
  const d = new Date(dateStr + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

function computeProgressSummary(blob) {
  const completed = blob.completed || {};
  const CATS = ["grammar", "vocabulary", "rc"];
  const isFull = (d) => {
    const c = completed[d];
    return !!c && CATS.every((cat) => c[cat]);
  };

  let current = 0;
  let d = getISTDateString();
  while (isFull(d)) {
    current++;
    d = addDaysStr(d, -1);
  }

  const fullDates = Object.keys(completed).filter(isFull).sort();
  let best = 0, run = 0, prev = null;
  for (const dt of fullDates) {
    run = prev && addDaysStr(prev, 1) === dt ? run + 1 : 1;
    if (run > best) best = run;
    prev = dt;
  }
  best = Math.max(best, current);

  let lastActive = null;
  for (const dt of Object.keys(completed).sort()) {
    const c = completed[dt];
    if (c && CATS.some((cat) => c[cat])) lastActive = dt;
  }

  return { current, best, mistakesOpen: (blob.mistakes || []).length, lastActive };
}

async function handleProgressSync(env, request) {
  const { telegram_id, blob } = await request.json();
  if (!telegram_id || !blob) throw new Error("telegram_id and blob are required.");

  await env.DB.prepare(
    `INSERT INTO user_progress (telegram_id, blob, updated_at) VALUES (?, ?, datetime('now'))
     ON CONFLICT(telegram_id) DO UPDATE SET blob = excluded.blob, updated_at = datetime('now')`
  )
    .bind(telegram_id, JSON.stringify(blob))
    .run();

  const summary = computeProgressSummary(blob);
  await env.DB.prepare(
    `UPDATE users SET current_streak = ?, best_streak = ?, mistakes_open = ?,
       last_active_date = COALESCE(?, last_active_date) WHERE telegram_id = ?`
  )
    .bind(summary.current, summary.best, summary.mistakesOpen, summary.lastActive, telegram_id)
    .run();

  return { ok: true };
}

async function handleProgressGet(env, telegramId) {
  const row = await env.DB.prepare(`SELECT blob FROM user_progress WHERE telegram_id = ?`).bind(telegramId).first();
  return { blob: row ? JSON.parse(row.blob) : null };
}

// ---------- weekly leaderboard (stored in a Google Sheet, not D1 — see README §Leaderboard) ----------
// A tiny Apps Script Web App acts as the "database": POST appends a row, GET returns all rows
// as JSON. This keeps a spreadsheet as the single source of truth, which is easy for a non-dev
// to open and eyeball, and needs no extra service beyond what's already free.

async function submitScoreToSheet(env, payload) {
  if (!env.GOOGLE_SHEET_WEBAPP_URL) return; // leaderboard not configured — skip quietly
  const body = new URLSearchParams({ ...payload, secret: env.GOOGLE_SHEET_SECRET || "" });
  await fetch(env.GOOGLE_SHEET_WEBAPP_URL, { method: "POST", body });
}

async function fetchLeaderboard(env, weekStart) {
  if (!env.GOOGLE_SHEET_WEBAPP_URL) return { configured: false, scores: [] };
  const u = `${env.GOOGLE_SHEET_WEBAPP_URL}?week=${encodeURIComponent(weekStart)}&secret=${encodeURIComponent(env.GOOGLE_SHEET_SECRET || "")}`;
  try {
    const res = await fetch(u);
    if (!res.ok) return { configured: true, scores: [] };
    const data = await res.json();
    const scores = (data.rows || [])
      .filter((r) => r.week_start === weekStart)
      .sort((a, b) => Number(b.pct) - Number(a.pct))
      .slice(0, 10)
      .map((r) => ({ first_name: r.first_name || "Student", pct: Number(r.pct) }));
    return { configured: true, scores };
  } catch {
    return { configured: true, scores: [] };
  }
}

async function handleLeaderboardSubmit(env, request) {
  const { telegram_id, week_start, pct, opt_in } = await request.json();
  if (!telegram_id || !week_start || pct == null) throw new Error("telegram_id, week_start and pct are required.");
  if (opt_in === false) return { ok: true, skipped: true };

  const already = await env.DB.prepare(
    `SELECT 1 FROM leaderboard_submissions WHERE telegram_id = ? AND week_start = ?`
  )
    .bind(telegram_id, week_start)
    .first();
  if (already) return { ok: true, duplicate: true };

  const user = await env.DB.prepare(`SELECT first_name FROM users WHERE telegram_id = ?`).bind(telegram_id).first();
  await submitScoreToSheet(env, {
    telegram_id: String(telegram_id),
    week_start,
    pct: String(pct),
    first_name: user?.first_name || "Student",
  });
  await env.DB.prepare(`INSERT INTO leaderboard_submissions (telegram_id, week_start, pct) VALUES (?, ?, ?)`)
    .bind(telegram_id, week_start, pct)
    .run();

  return { ok: true };
}

// ---------- "log in from inside Telegram" (deep link, no widget popup) ----------
// Tokens live in KV, not D1, specifically so they can self-expire with zero cleanup code:
// a token that's never approved just falls out of KV after PENDING_TTL; one that's approved
// but never picked up by the site falls out after VERIFIED_TTL. The moment the site's poll
// successfully reads a verified token, it's deleted immediately — so a link can only ever
// complete one login, never two.

// NOTE: these used to be 180/120 — exactly equal to the site's old 180000ms poll timeout.
// That meant a login approved near the edge of the pending window could get claimed just as
// (or after) the browser gave up polling, so the "verified" entry sat in KV and was never read.
// Bumped both up with real headroom, and the client's poll timeout (progress.js) now comfortably
// outlasts PENDING_TTL + VERIFIED_TTL combined.
const LOGIN_PENDING_TTL = 300; // 5 minutes to open the bot and approve
const LOGIN_VERIFIED_TTL = 300; // 5 more minutes for the site to notice and finish signing in

function randomCode() {
  return crypto.randomUUID().replace(/-/g, "").slice(0, 12);
}

async function upsertUser(env, u) {
  await env.DB.prepare(
    `INSERT INTO users (telegram_id, username, first_name, photo_url, last_seen_at)
     VALUES (?, ?, ?, ?, datetime('now'))
     ON CONFLICT(telegram_id) DO UPDATE SET
       username = excluded.username,
       first_name = excluded.first_name,
       photo_url = excluded.photo_url,
       last_seen_at = datetime('now')`
  )
    .bind(u.id, u.username || null, u.first_name || null, u.photo_url || null)
    .run();
}

// Called by the website: creates a pending token and hands back the t.me deep link to open it.
async function handleLoginStart(env) {
  const code = randomCode();
  await env.LOGIN_KV.put(code, JSON.stringify({ status: "pending" }), { expirationTtl: LOGIN_PENDING_TTL });
  const botUsername = env.TELEGRAM_BOT_USERNAME || BOT_USERNAME;
  return { code, botLink: `https://t.me/${botUsername}?start=${code}` };
}

// Called by the website's poll loop. Deletes the token the instant it's successfully read as
// verified, so the same link can never be used for a second login.
async function handleLoginStatus(env, code) {
  const raw = await env.LOGIN_KV.get(code);
  if (!raw) return { claimed: false, expired: true };
  const entry = JSON.parse(raw);
  if (entry.status !== "verified") return { claimed: false };
  await env.LOGIN_KV.delete(code);
  return { claimed: true, user: entry.user };
}

// Called from the bot webhook once a code is approved via /start <code>.
async function claimLoginCode(env, code, tgUser) {
  const raw = await env.LOGIN_KV.get(code);
  if (!raw) return false;
  const entry = JSON.parse(raw);
  if (entry.status !== "pending") return false;
  await upsertUser(env, tgUser);
  await env.LOGIN_KV.put(code, JSON.stringify({ status: "verified", user: tgUser }), { expirationTtl: LOGIN_VERIFIED_TTL });
  return true;
}

// Called from the bot webhook when someone types plain /start for the first time — self-issues
// an already-verified token and a magic link, so opening it in any browser signs them straight
// in. The caller (webhook) is responsible for upserting the user row before calling this.
async function issueSelfLoginLink(env, tgUser) {
  const code = randomCode();
  await env.LOGIN_KV.put(code, JSON.stringify({ status: "verified", user: tgUser }), { expirationTtl: LOGIN_VERIFIED_TTL });
  return `${SITE_URL}/telegram-callback.html?login_code=${code}`;
}

// ---------- Telegram sign-in + bot delivery ----------
// TELEGRAM_BOT_TOKEN must be set with `wrangler secret put TELEGRAM_BOT_TOKEN` — never hardcode it here.
// The Login Widget signs its payload with this same token, so this one secret covers both login
// verification and sending messages/documents (Telegram doesn't use separate client id/secret pairs).

async function verifyTelegramAuth(data, botToken) {
  const authDate = parseInt(data.auth_date, 10);
  if (!authDate || Math.abs(Date.now() / 1000 - authDate) > 86400) return false; // reject stale (>24h) payloads

  const { hash, ...fields } = data;
  const checkString = Object.keys(fields)
    .sort()
    .map((k) => `${k}=${fields[k]}`)
    .join("\n");

  const encoder = new TextEncoder();
  const secretKeyBytes = await crypto.subtle.digest("SHA-256", encoder.encode(botToken));
  const key = await crypto.subtle.importKey("raw", secretKeyBytes, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sigBuf = await crypto.subtle.sign("HMAC", key, encoder.encode(checkString));
  const hex = [...new Uint8Array(sigBuf)].map((b) => b.toString(16).padStart(2, "0")).join("");

  return hex === hash;
}

// verifyTelegramAuth (below) still does the official HMAC-SHA256 check per Telegram's docs —
// that part was always correct and is reused by the new official-widget flow unchanged.

async function handleTelegramAuth(env, request) {
  if (!env.TELEGRAM_BOT_TOKEN) throw new Error("Telegram login isn't configured on the server yet.");
  const data = await request.json();

  const valid = await verifyTelegramAuth(data, env.TELEGRAM_BOT_TOKEN);
  if (!valid) throw new Error("Telegram login verification failed.");

  await upsertUser(env, { id: data.id, username: data.username, first_name: data.first_name, photo_url: data.photo_url });

  // Confirm it worked right inside the chat with the bot. This can fail silently if the person
  // has never opened a chat with @Tiny_english_robot before — Telegram requires that before a
  // bot can message someone — so it's wrapped so a failed notify never fails the sign-in itself.
  try {
    await sendTelegramMessage(
      env,
      data.id,
      `✅ You're logged in${data.first_name ? `, ${data.first_name}` : ""}! I'll send your weekly score card here every Sunday.`
    );
  } catch (err) {
    // Most likely they haven't messaged the bot yet — sign-in still succeeded either way.
  }

  return { ok: true, user: { id: data.id, username: data.username, first_name: data.first_name, photo_url: data.photo_url } };
}

async function sendTelegramMessage(env, chatId, text) {
  if (!env.TELEGRAM_BOT_TOKEN) throw new Error("Telegram bot isn't configured on the server yet.");
  const res = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text, parse_mode: "HTML" }),
  });
  const data = await res.json();
  if (!data.ok) throw new Error(data.description || "Telegram send failed");
  return data;
}

async function handleTelegramNotify(env, request) {
  const { telegram_id, message } = await request.json();
  if (!telegram_id || !message) throw new Error("telegram_id and message are required.");
  await sendTelegramMessage(env, telegram_id, message);
  return { ok: true };
}

// Sends a native Telegram quiz poll (sendPoll, type: quiz) — answerable right inside the chat,
// no browser needed. Telegram itself reveals the correct answer + explanation once tapped.
async function sendTelegramQuiz(env, chatId, row) {
  const letters = ["a", "b", "c", "d"];
  const options = [row.option_a, row.option_b, row.option_c, row.option_d].map((o) => (o || "").slice(0, 100));
  const correctIdx = Math.max(0, letters.indexOf((row.correct_option || "a").toLowerCase()));

  const res = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendPoll`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      question: (row.question || "").slice(0, 300),
      options,
      type: "quiz",
      correct_option_id: correctIdx,
      explanation: (row.explanation || "").slice(0, 200),
      is_anonymous: true,
    }),
  });
  const data = await res.json();
  if (!data.ok) throw new Error(data.description || "sendPoll failed");
  return data;
}

function daysBetween(a, b) {
  const da = new Date(a + "T00:00:00Z");
  const db = new Date(b + "T00:00:00Z");
  return Math.round((db - da) / 86400000);
}

// Push, don't just pull: loops every opted-in user once the cron has generated today's content
// and proactively messages them, instead of waiting for someone to type /today. On Sundays this
// also mentions the newly-unlocked Weekly Test — that reminder only ever goes out via Telegram,
// never as any kind of website popup/notification.
async function pushMorningNotifications(env, date) {
  if (!env.TELEGRAM_BOT_TOKEN) return;
  const isSunday = getISTDayOfWeek() === 0;

  const rows = await env.DB.prepare(
    `SELECT telegram_id, first_name, last_push_date FROM users WHERE COALESCE(opt_out_push, 0) = 0`
  ).all();
  const users = rows.results || [];
  if (!users.length) return;

  // One quick 1-question quiz poll alongside the push, best-effort (grammar/vocab reads better
  // as a standalone poll question than an RC question, which needs the passage for context).
  const quizRow = await env.DB.prepare(
    `SELECT question, option_a, option_b, option_c, option_d, correct_option, explanation
     FROM daily_content WHERE date = ? AND category IN ('grammar','vocabulary') ORDER BY RANDOM() LIMIT 1`
  )
    .bind(date)
    .first();

  for (const u of users) {
    if (u.last_push_date === date) continue; // already pushed today — cron shouldn't double-run, but be safe
    try {
      const greeting = u.first_name ? `Hi ${u.first_name}! ` : "";
      const weeklyLine = isSunday ? `\n\n🗓️ It's Sunday — the Weekly Test is unlocked!\n${SITE_URL}/weekly-test.html` : "";
      await sendTelegramMessage(
        env,
        u.telegram_id,
        `☀️ ${greeting}Today's Grammar, Vocabulary &amp; RC set is ready.\n${SITE_URL}/practice.html${weeklyLine}`
      );
      if (quizRow) {
        try { await sendTelegramQuiz(env, u.telegram_id, quizRow); } catch (e) { /* poll is a bonus, not critical */ }
      }
      await env.DB.prepare(`UPDATE users SET last_push_date = ? WHERE telegram_id = ?`).bind(date, u.telegram_id).run();
    } catch (err) {
      // Most likely they blocked the bot — skip and move on to the next user.
    }
  }
}

// "You're about to lose your streak" nudges — anyone who's practiced before but has gone 2+
// days quiet gets a gentle ping, once per day at most.
async function sendInactivityNudges(env, date) {
  if (!env.TELEGRAM_BOT_TOKEN) return;
  const rows = await env.DB.prepare(
    `SELECT telegram_id, first_name, last_active_date, current_streak, last_nudge_date
     FROM users WHERE COALESCE(opt_out_push, 0) = 0`
  ).all();

  for (const u of rows.results || []) {
    if (!u.last_active_date) continue; // never practiced yet — not a "losing a streak" situation
    if (u.last_nudge_date === date) continue;
    const gap = daysBetween(u.last_active_date, date);
    if (gap < 2) continue;
    try {
      const streakLine = u.current_streak > 0 ? ` — your ${u.current_streak}-day streak is at risk` : "";
      await sendTelegramMessage(
        env,
        u.telegram_id,
        `⏳ ${u.first_name ? u.first_name + ", " : ""}you haven't practiced in ${gap} days${streakLine}. A set takes about 5 minutes:\n${SITE_URL}/practice.html`
      );
      await env.DB.prepare(`UPDATE users SET last_nudge_date = ? WHERE telegram_id = ?`).bind(date, u.telegram_id).run();
    } catch (err) {
      // Blocked bot or transient failure — try again on the next quiet day.
    }
  }
}

async function handleTelegramSendPdf(env, request) {
  if (!env.TELEGRAM_BOT_TOKEN) throw new Error("Telegram bot isn't configured on the server yet.");
  const form = await request.formData();
  const telegramId = form.get("telegram_id");
  const file = form.get("file");
  if (!telegramId || !file) throw new Error("telegram_id and file are required.");

  const upstream = new FormData();
  upstream.append("chat_id", telegramId);
  upstream.append("document", file, "weekly-score.pdf");
  upstream.append("caption", "Your Weekly Test Score \u{1F3C6}");

  const res = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendDocument`, {
    method: "POST",
    body: upstream,
  });
  const data = await res.json();
  if (!data.ok) throw new Error(data.description || "Telegram send failed");
  return { ok: true };
}

// ---------- Telegram bot webhook (the actual interactive bot, e.g. /start, /today) ----------
// This is separate from "Sign in with Telegram" above: that's the Login Widget verifying a
// signed payload from the browser; this is Telegram pushing chat updates to the bot itself.
// Both use the same TELEGRAM_BOT_TOKEN — one bot, two features.
//
// One-time setup after you deploy:
//   1. Pick any random string as a webhook secret and store it:
//        npx wrangler secret put TELEGRAM_WEBHOOK_SECRET
//   2. Tell Telegram where to send updates (fill in your token, deploy URL, and the same secret):
//        curl "https://api.telegram.org/bot<TELEGRAM_BOT_TOKEN>/setWebhook?url=<SITE_URL>/api/telegram/webhook&secret_token=<TELEGRAM_WEBHOOK_SECRET>"
//      Replace <SITE_URL> with the same value you set for the SITE_URL constant above.
//   3. Confirm it registered: curl "https://api.telegram.org/bot<TELEGRAM_BOT_TOKEN>/getWebhookInfo"
async function handleTelegramWebhook(env, request) {
  // Telegram echoes back whatever secret_token you registered with setWebhook, in this header —
  // reject anything that doesn't match so randoms can't POST fake updates at your bot.
  const incomingSecret = request.headers.get("X-Telegram-Bot-Api-Secret-Token");
  if (!env.TELEGRAM_WEBHOOK_SECRET || incomingSecret !== env.TELEGRAM_WEBHOOK_SECRET) {
    return new Response("Unauthorized", { status: 401 });
  }

  const update = await request.json().catch(() => null);
  const msg = update && (update.message || update.edited_message);

  if (msg && typeof msg.text === "string") {
    const chatId = msg.chat.id;
    const text = msg.text.trim();

    try {
      const startPayloadMatch = text.match(/^\/start\s+(\S+)$/);

      if (startPayloadMatch) {
        // Deep link from the website's "Log in from Telegram" button: /start <code>
        const code = startPayloadMatch[1];
        const tgUser = { id: chatId, username: msg.from.username, first_name: msg.from.first_name, photo_url: null };
        const claimed = await claimLoginCode(env, code, tgUser);
        await env.DB.prepare(`UPDATE users SET opt_out_push = 0 WHERE telegram_id = ?`).bind(chatId).run();
        await sendTelegramMessage(
          env,
          chatId,
          claimed
            ? `✅ Logged in! Go back to your browser tab — it'll sign you in within a couple seconds.`
            : `That login link has expired or was already used. Open the site again and tap "Log in with Telegram" for a fresh one.\n${SITE_URL}`
        );
      } else if (text === "/start") {
        const tgUser = { id: chatId, username: msg.from.username, first_name: msg.from.first_name, photo_url: null };
        const existing = await env.DB.prepare(`SELECT telegram_id FROM users WHERE telegram_id = ?`).bind(chatId).first();
        await upsertUser(env, tgUser); // always save/refresh their id, known or not
        await env.DB.prepare(`UPDATE users SET opt_out_push = 0 WHERE telegram_id = ?`).bind(chatId).run();

        const commandsList =
          `Commands:\n/today — today's practice link\n/week — this week's test status\n/streak — your current & best streak\n/mistakes — saved mistakes waiting for review\n/stop — pause daily/weekly messages\n/help — show this again`;

        if (existing) {
          // Already known — no need to hand out a fresh sign-in link every single time they say hi.
          await sendTelegramMessage(env, chatId, `👋 Welcome back${tgUser.first_name ? `, ${tgUser.first_name}` : ""}!\n\n${commandsList}`);
        } else {
          // First contact — /start doubles as sign-in, no separate /login command needed.
          const magicLink = await issueSelfLoginLink(env, tgUser);
          await sendTelegramMessage(
            env,
            chatId,
            `👋 Welcome to <b>WonderMayank — RC / Grammar / Vocabulary</b>!\n\n` +
              `🔗 Tap to sign in on the website (works once, expires in 5 minutes):\n${magicLink}\n\n` +
              `I'll push today's set every morning and your weekly score card automatically once you're signed in.\n\n${commandsList}`
          );
        }
      } else if (text === "/help") {
        await sendTelegramMessage(
          env,
          chatId,
          `Commands:\n/today — today's practice link\n/week — this week's test status\n/streak — your current & best streak\n/mistakes — saved mistakes waiting for review\n/stop — pause daily/weekly messages\n/start — welcome message + a fresh sign-in link`
        );
      } else if (text === "/today") {
        await sendTelegramMessage(env, chatId, `📚 Today's Grammar, Vocabulary &amp; RC practice:\n${SITE_URL}/practice.html`);
      } else if (text === "/week") {
        const status = await getWeekStatus(env);
        const line = status.isSunday
          ? status.testGenerated
            ? "The weekly test is generated — go take it!"
            : "It's Sunday — the weekly test is unlocked, go generate it!"
          : `Not Sunday yet — ${status.questionsThisWeek} questions logged so far this week.`;
        await sendTelegramMessage(env, chatId, `🗓️ ${line}\n${SITE_URL}/weekly-test.html`);
      } else if (text === "/streak") {
        const u = await env.DB.prepare(`SELECT current_streak, best_streak FROM users WHERE telegram_id = ?`).bind(chatId).first();
        await sendTelegramMessage(
          env,
          chatId,
          `🔥 Current streak: <b>${u?.current_streak || 0}</b> day(s)\n🏆 Best streak: <b>${u?.best_streak || 0}</b> day(s)\n\n(This updates once you've signed in and practiced on the website.)`
        );
      } else if (text === "/mistakes") {
        const u = await env.DB.prepare(`SELECT mistakes_open FROM users WHERE telegram_id = ?`).bind(chatId).first();
        const n = u?.mistakes_open || 0;
        await sendTelegramMessage(
          env,
          chatId,
          n > 0
            ? `📝 You have <b>${n}</b> saved mistake(s) waiting for review.\n${SITE_URL}/mistakes.html`
            : `🎉 No open mistakes saved — you're all caught up!\n${SITE_URL}/mistakes.html`
        );
      } else if (text === "/stop") {
        await env.DB.prepare(`UPDATE users SET opt_out_push = 1 WHERE telegram_id = ?`).bind(chatId).run();
        await sendTelegramMessage(env, chatId, "🔕 Okay — no more daily/weekly pushes. Send /start anytime to turn them back on.");
      } else {
        await sendTelegramMessage(env, chatId, "Not sure what you mean — try /help.");
      }
    } catch (err) {
      // Don't throw: Telegram retries webhooks that don't return 200, which would just
      // resend the same update. The failed send is the only thing lost here.
    }
  }

  // Always reply 200 fast, or Telegram queues retries of this same update.
  return new Response("ok", { status: 200 });
}

async function buildWeeklyTestPayload(env, start, end, ids) {
  const placeholders = ids.map(() => "?").join(",");
  const rows = await env.DB.prepare(
    `SELECT id, category, passage, question, option_a, option_b, option_c, option_d, correct_option, explanation, topic_tag, date
     FROM daily_content WHERE id IN (${placeholders})`
  )
    .bind(...ids)
    .all();

  const byId = new Map((rows.results || []).map((r) => [r.id, r]));
  const questions = ids
    .map((id) => {
      const r = byId.get(id);
      if (!r) return null;
      return {
        id: r.id,
        date: r.date,
        category: r.category,
        passage: r.category === "rc" ? r.passage : null,
        question: r.question,
        options: { a: r.option_a, b: r.option_b, c: r.option_c, d: r.option_d },
        correct: r.correct_option,
        explanation: r.explanation,
        topic: r.topic_tag,
      };
    })
    .filter(Boolean);

  return { weekStart: start, weekEnd: end, totalQuestions: questions.length, questions };
}
