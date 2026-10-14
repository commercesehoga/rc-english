// WonderMayank RC / Grammar / Vocabulary — Cloudflare Worker
// Handles: daily question generation (Groq), D1 storage, archive lookup, weekly Sunday CBT test,
// and the Google-Sheet-backed weekly leaderboard. No login: the leaderboard uses an anonymous
// per-device id + a nickname. The Telegram bot is hosted separately (see /telegram-bot).

// Groq models, tried in order. If one fails (no access, rate limit, bad JSON), the next is used.
// To change the list without editing code, set a GROQ_MODELS variable (comma-separated) in
// wrangler.toml [vars] or the Cloudflare dashboard.
const DEFAULT_GROQ_MODELS = [
  "openai/gpt-oss-120b",
  "openai/gpt-oss-20b",
  "llama-3.3-70b-versatile",
];

function getGroqModels(env) {
  const custom = (env.GROQ_MODELS || "").split(",").map((m) => m.trim()).filter(Boolean);
  return custom.length ? custom : DEFAULT_GROQ_MODELS;
}
const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;

// Earliest date the site will ever generate content for (make.html backfill can't go before it).
const MIN_CONTENT_DATE = "2026-01-01";

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

// Generates the day's content once a day.
async function runDailyCron(env, date) {
  await generateDailyContent(env, date);
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

    if (pathname === "/api/make/status" && request.method === "GET") {
      return json(await getMakeStatus(env, url.searchParams.get("from")), headers);
    }

    if (pathname === "/api/make/models" && request.method === "GET") {
      // Lists the models your Groq key can actually use, and which of them this app is set to try.
      const r = await fetch("https://api.groq.com/openai/v1/models", {
        headers: { Authorization: `Bearer ${env.GROQ_API_KEY}` },
      });
      const data = await r.json().catch(() => ({}));
      const available = (data.data || []).map((m) => m.id).sort();
      const configured = getGroqModels(env);
      return json(
        { configured, usable: configured.filter((m) => available.includes(m)), available, groqStatus: r.status },
        headers
      );
    }

    if (pathname === "/api/make/run" && request.method === "POST") {
      // Optional protection: if you set a MAKE_KEY secret, the /make.html page must send it.
      if (env.MAKE_KEY && request.headers.get("X-Make-Key") !== env.MAKE_KEY) {
        return json({ error: "Wrong or missing make key" }, headers, 401);
      }
      const body = await request.json().catch(() => ({}));
      return json(await runMakeForDate(env, body.date), headers);
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

    // Public read-only endpoint used by the separate Telegram bot (and anyone else): one random
    // archived question. ?category=grammar|vocabulary|rc (optional).
    if (pathname === "/api/random-question" && request.method === "GET") {
      return json(await getRandomQuestion(env, url.searchParams.get("category")), headers);
    }

    if (pathname === "/api/leaderboard/submit" && request.method === "POST") {
      return json(await handleLeaderboardSubmit(env, request), headers);
    }

    const lbMatch = pathname.match(/^\/api\/leaderboard\/(\d{4}-\d{2}-\d{2})$/);
    if (lbMatch && request.method === "GET") {
      return json(await fetchLeaderboard(env, lbMatch[1]), headers);
    }

    // ---- Admin DB tool (db-tool.html): export / import D1 tables ----
    if (pathname.startsWith("/api/admin/")) {
      return json(await handleAdmin(request, env, url, pathname), headers, adminAuthFailed(request, env) ? 401 : 200);
    }

    return json({ error: "Not found" }, headers, 404);
  } catch (err) {
    return json({ error: err.message || "Server error" }, headers, 500);
  }
}

// ---------- admin: D1 export / import (used by public/db-tool.html) ----------
// Protected by the DB_TOOL_KEY secret (falls back to MAKE_KEY). If neither is set the tool is
// disabled, so the database is never exposed by accident.
//   npx wrangler secret put DB_TOOL_KEY

function adminAuthFailed(request, env) {
  const key = env.DB_TOOL_KEY || env.MAKE_KEY;
  if (!key) return true;
  return request.headers.get("X-Make-Key") !== key;
}

const ADMIN_MAX_ROWS = 2000;     // rows per export request
const ADMIN_MAX_IMPORT = 500;    // rows per import request

async function adminTables(env) {
  const { results } = await env.DB.prepare(
    "SELECT name, sql FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' ORDER BY name"
  ).all();
  const out = [];
  for (const t of results) {
    const cols = await env.DB.prepare(`PRAGMA table_info("${t.name}")`).all();
    const c = await env.DB.prepare(`SELECT COUNT(*) AS n FROM "${t.name}"`).first();
    out.push({
      name: t.name,
      sql: t.sql,
      rows: c ? c.n : 0,
      columns: cols.results.map((x) => ({ name: x.name, type: x.type, pk: x.pk })),
    });
  }
  return out;
}

async function handleAdmin(request, env, url, pathname) {
  const key = env.DB_TOOL_KEY || env.MAKE_KEY;
  if (!key) return { error: "Set a DB_TOOL_KEY secret first (npx wrangler secret put DB_TOOL_KEY)" };
  if (adminAuthFailed(request, env)) return { error: "Wrong or missing key" };

  if (pathname === "/api/admin/tables" && request.method === "GET") {
    return { tables: await adminTables(env) };
  }

  // GET /api/admin/export?table=NAME&offset=0&limit=1000
  if (pathname === "/api/admin/export" && request.method === "GET") {
    const tables = await adminTables(env);
    const t = tables.find((x) => x.name === url.searchParams.get("table"));
    if (!t) return { error: "Unknown table" };
    const offset = Math.max(0, parseInt(url.searchParams.get("offset") || "0", 10) || 0);
    const limit = Math.min(ADMIN_MAX_ROWS, Math.max(1, parseInt(url.searchParams.get("limit") || "1000", 10) || 1000));
    const { results } = await env.DB.prepare(`SELECT * FROM "${t.name}" LIMIT ? OFFSET ?`).bind(limit, offset).all();
    return { table: t.name, offset, count: results.length, total: t.rows, rows: results };
  }

  // POST /api/admin/import  { table, mode: "ignore" | "replace", wipe: bool, rows: [...] }
  if (pathname === "/api/admin/import" && request.method === "POST") {
    const body = await request.json().catch(() => null);
    if (!body || !Array.isArray(body.rows)) return { error: "Body must be { table, mode, wipe, rows: [] }" };
    if (body.rows.length > ADMIN_MAX_IMPORT) return { error: "Too many rows in one request (max " + ADMIN_MAX_IMPORT + ")" };
    const tables = await adminTables(env);
    const t = tables.find((x) => x.name === body.table);
    if (!t) return { error: "Unknown table: " + body.table };
    const allowed = new Set(t.columns.map((c) => c.name));
    const verb = body.mode === "replace" ? "INSERT OR REPLACE" : "INSERT OR IGNORE";

    const stmts = [];
    if (body.wipe) stmts.push(env.DB.prepare(`DELETE FROM "${t.name}"`));
    let skipped = 0;
    for (const row of body.rows) {
      const cols = Object.keys(row || {}).filter((c) => allowed.has(c));
      if (!cols.length) { skipped++; continue; }
      const sql = `${verb} INTO "${t.name}" (${cols.map((c) => `"${c}"`).join(",")}) VALUES (${cols.map(() => "?").join(",")})`;
      stmts.push(env.DB.prepare(sql).bind(...cols.map((c) => (row[c] === undefined ? null : row[c]))));
    }
    if (stmts.length) await env.DB.batch(stmts);
    return { ok: true, table: t.name, received: body.rows.length, skipped, wiped: !!body.wipe };
  }

  return { error: "Not found" };
}

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, X-Make-Key",
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

function isValidQuestions(data) {
  if (!data || !Array.isArray(data.questions) || data.questions.length < 1) return false;
  return data.questions.every(
    (q) =>
      q &&
      typeof q.question === "string" &&
      q.options &&
      ["a", "b", "c", "d"].every((k) => typeof q.options[k] === "string") &&
      ["a", "b", "c", "d"].includes(q.correct)
  );
}

async function callGroqModel(env, model, systemPrompt, userPrompt) {
  const body = {
    model,
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userPrompt },
    ],
    temperature: 0.85,
    response_format: { type: "json_object" },
  };
  if (model.startsWith("openai/gpt-oss")) {
    // GPT OSS are reasoning models: keep reasoning short and leave room for the JSON answer.
    body.reasoning_effort = "low";
    body.max_completion_tokens = 8192;
  } else {
    body.max_completion_tokens = 4096;
  }

  const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${env.GROQ_API_KEY}`,
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Groq ${model} error ${res.status}: ${errText.slice(0, 300)}`);
  }

  const data = await res.json();
  let raw = data.choices?.[0]?.message?.content || "{}";
  raw = raw.trim().replace(/^```json\s*/i, "").replace(/^```\s*/i, "").replace(/```$/i, "");
  const parsed = JSON.parse(raw);
  if (!isValidQuestions(parsed)) throw new Error(`Groq ${model} returned an invalid question set`);
  return parsed;
}

async function callGroq(env, systemPrompt, userPrompt) {
  const errors = [];
  for (const model of getGroqModels(env)) {
    try {
      return await callGroqModel(env, model, systemPrompt, userPrompt);
    } catch (err) {
      errors.push(err.message);
      console.warn(`Groq model failed, trying next: ${err.message}`);
    }
  }
  // Report every model's failure, not just the last one, so the real cause is visible.
  throw new Error(`All Groq models failed. ${errors.join(" | ")}`);
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

// ---------- /make.html backfill helpers ----------

const ALL_CATEGORIES = ["grammar", "vocabulary", "rc"];

// Compares what's in D1 against every calendar day from `from` (default: the earliest day in D1)
// up to today (IST), and reports which days are complete, partial, or missing entirely.
async function getMakeStatus(env, fromParam) {
  const today = getISTDateString();
  const rows = await env.DB.prepare(
    `SELECT date, GROUP_CONCAT(DISTINCT category) AS cats, COUNT(*) AS n
     FROM daily_content GROUP BY date ORDER BY date`
  ).all();
  const byDate = {};
  for (const r of rows.results || []) {
    byDate[r.date] = { categories: (r.cats || "").split(","), questions: r.n };
  }
  const dates = Object.keys(byDate).sort();
  const first = dates[0] || null;
  const last = dates[dates.length - 1] || null;

  let from = /^\d{4}-\d{2}-\d{2}$/.test(fromParam || "") ? fromParam : first || today;
  if (from < MIN_CONTENT_DATE) from = MIN_CONTENT_DATE; // never before 1 Jan 2026
  if (from > today) from = today;

  const days = [];
  let cursor = from;
  for (let i = 0; i < 800 && cursor <= today; i++) {
    const have = byDate[cursor]?.categories || [];
    const missing = ALL_CATEGORIES.filter((c) => !have.includes(c));
    days.push({
      date: cursor,
      state: missing.length === 0 ? "done" : have.length === 0 ? "missing" : "partial",
      missing,
    });
    cursor = addDaysStr(cursor, 1);
  }

  return {
    today,
    minDate: MIN_CONTENT_DATE,
    first,
    last,
    from,
    totalDaysInDb: dates.length,
    remaining: days.filter((d) => d.state !== "done").length,
    days,
  };
}

// Generates whatever is missing for ONE date. The page calls this once per date so each request
// stays well inside Worker time and subrequest limits.
async function runMakeForDate(env, date) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date || "")) throw new Error("Invalid date");
  if (date < MIN_CONTENT_DATE) throw new Error("Cannot generate a date before 1 Jan 2026");
  if (date > getISTDateString()) throw new Error("Cannot generate a future date");
  await generateDailyContent(env, date);
  const r = await env.DB.prepare(`SELECT DISTINCT category FROM daily_content WHERE date = ?`)
    .bind(date)
    .all();
  const have = (r.results || []).map((x) => x.category);
  const missing = ALL_CATEGORIES.filter((c) => !have.includes(c));
  return { date, ok: missing.length === 0, missing };
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

function addDaysStr(dateStr, n) {
  const d = new Date(dateStr + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
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

// No login any more: the browser makes a random device id (localStorage) and the person types a
// nickname on the result screen. The device id only stops the same browser posting twice a week.
// (The D1 column is still called telegram_id from the old schema — SQLite stores text there fine.)
function cleanNickname(name) {
  const n = String(name || "").replace(/[\u0000-\u001f<>]/g, "").replace(/\s+/g, " ").trim().slice(0, 24);
  return n || "Student";
}

async function handleLeaderboardSubmit(env, request) {
  const { device_id, name, week_start, pct, opt_in } = await request.json();
  if (!device_id || !week_start || pct == null) throw new Error("device_id, week_start and pct are required.");
  if (!/^[a-zA-Z0-9-]{8,64}$/.test(String(device_id))) throw new Error("Invalid device id.");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(week_start))) throw new Error("Invalid week_start.");
  const score = Math.max(0, Math.min(100, Math.round(Number(pct))));
  if (Number.isNaN(score)) throw new Error("Invalid score.");
  if (opt_in === false) return { ok: true, skipped: true };

  const already = await env.DB.prepare(
    `SELECT 1 FROM leaderboard_submissions WHERE telegram_id = ? AND week_start = ?`
  )
    .bind(String(device_id), week_start)
    .first();
  if (already) return { ok: true, duplicate: true };

  await submitScoreToSheet(env, {
    telegram_id: String(device_id),
    week_start,
    pct: String(score),
    first_name: cleanNickname(name),
  });
  await env.DB.prepare(`INSERT INTO leaderboard_submissions (telegram_id, week_start, pct) VALUES (?, ?, ?)`)
    .bind(String(device_id), week_start, score)
    .run();

  return { ok: true };
}

// ---------- random question (used by the separately hosted Telegram bot) ----------

async function getRandomQuestion(env, category) {
  const cat = ["grammar", "vocabulary", "rc"].includes(category) ? category : null;
  const row = await env.DB.prepare(
    `SELECT id, date, category, passage, question, option_a, option_b, option_c, option_d, correct_option, explanation, topic_tag, difficulty
     FROM daily_content ${cat ? "WHERE category = ?" : ""} ORDER BY RANDOM() LIMIT 1`
  )
    .bind(...(cat ? [cat] : []))
    .first();
  if (!row) throw new Error("No questions stored yet.");
  return {
    id: row.id,
    date: row.date,
    category: row.category,
    passage: row.category === "rc" ? row.passage : null,
    question: row.question,
    options: { a: row.option_a, b: row.option_b, c: row.option_c, d: row.option_d },
    correct: row.correct_option,
    explanation: row.explanation,
    topic: row.topic_tag,
    difficulty: row.difficulty,
  };
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
