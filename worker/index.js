// WonderMayank RC / Grammar / Vocabulary — Cloudflare Worker
// Handles: daily question generation (Groq), D1 storage, archive lookup, weekly Sunday CBT test.

const GROQ_MODEL = "llama-3.3-70b-versatile";
const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;

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

  // Cron trigger — see [triggers] in wrangler.toml (runs once daily).
  async scheduled(controller, env, ctx) {
    ctx.waitUntil(generateDailyContent(env, getISTDateString()));
  },
};

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
