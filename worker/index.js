// WonderMayank RC / Grammar / Vocabulary — Cloudflare Worker
// Handles: daily question generation (Groq), D1 storage, archive lookup, weekly Sunday CBT test.

const GROQ_MODEL = "llama-3.3-70b-versatile";
const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;

// Used inside the Telegram bot's replies (/start, /today, /week). Update this if/when you
// put the app on a custom domain (Settings → Domains & Routes) — see README section 8.
const SITE_URL = "https://english.thunderstudy.indevs.in"; // used in the bot's /start, /today, /week replies

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

    if (pathname === "/api/practice/custom" && request.method === "GET") {
      const topics = (url.searchParams.get("topics") || "")
        .split(",")
        .map((t) => t.trim())
        .filter(Boolean)
        .slice(0, 10);
      return json(await getCustomPractice(env, topics), headers);
    }

    if (pathname === "/api/auth/telegram" && request.method === "POST") {
      return json(await handleTelegramAuth(env, request), headers);
    }

    // Opened via window.open(..., '_blank') from the site — sends the browser straight to
    // Telegram's full-page OAuth screen (embed=0) in that new tab, instead of the small popup
    // the default telegram-widget.js opens. Telegram redirects back to telegram-callback.html
    // with the signed user data once the person approves the login.
    if (pathname === "/api/auth/telegram/start" && request.method === "GET") {
      return startTelegramAuth(env, url);
    }

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

// ---------- weekly topic-picker practice (up to 10 topics, 10 questions, pulled from the full archive) ----------

async function getCustomPractice(env, topics) {
  if (!topics.length) throw new Error("Select at least one topic.");
  const placeholders = topics.map(() => "?").join(",");
  const rows = await env.DB.prepare(
    `SELECT id, category, passage, question, option_a, option_b, option_c, option_d, correct_option, explanation, topic_tag, difficulty, date
     FROM daily_content WHERE topic_tag IN (${placeholders}) ORDER BY RANDOM() LIMIT 10`
  )
    .bind(...topics)
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

// Redirects straight to Telegram's real OAuth page (a genuine new browser tab, full URL bar
// and all) instead of the small JS popup that the embedded telegram-widget.js normally opens.
// bot_id is just the numeric prefix of the bot token (before the colon) — no extra secret needed.
function startTelegramAuth(env, url) {
  if (!env.TELEGRAM_BOT_TOKEN) {
    return new Response("Telegram login isn't configured on the server yet.", { status: 500 });
  }
  const botId = env.TELEGRAM_BOT_TOKEN.split(":")[0];
  const origin = url.origin;
  const returnTo = `${origin}/telegram-callback.html`;

  const authorizeUrl =
    `https://oauth.telegram.org/auth?bot_id=${encodeURIComponent(botId)}` +
    `&origin=${encodeURIComponent(origin)}` +
    `&embed=0&request_access=write` +
    `&return_to=${encodeURIComponent(returnTo)}`;

  return Response.redirect(authorizeUrl, 302);
}

async function handleTelegramAuth(env, request) {
  if (!env.TELEGRAM_BOT_TOKEN) throw new Error("Telegram login isn't configured on the server yet.");
  const data = await request.json();

  const valid = await verifyTelegramAuth(data, env.TELEGRAM_BOT_TOKEN);
  if (!valid) throw new Error("Telegram login verification failed.");

  await env.DB.prepare(
    `INSERT INTO users (telegram_id, username, first_name, photo_url, last_seen_at)
     VALUES (?, ?, ?, ?, datetime('now'))
     ON CONFLICT(telegram_id) DO UPDATE SET
       username = excluded.username,
       first_name = excluded.first_name,
       photo_url = excluded.photo_url,
       last_seen_at = datetime('now')`
  )
    .bind(data.id, data.username || null, data.first_name || null, data.photo_url || null)
    .run();

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
      if (text === "/start" || text.startsWith("/start ")) {
        await sendTelegramMessage(
          env,
          chatId,
          `👋 Welcome to <b>WonderMayank — RC / Grammar / Vocabulary</b>!\n\n` +
            `Sign in with Telegram on the website and I'll send your weekly score card here automatically.\n\n` +
            `🔗 ${SITE_URL}\n\n` +
            `Commands:\n/today — today's practice link\n/week — this week's test status\n/help — show this again`
        );
      } else if (text === "/help") {
        await sendTelegramMessage(
          env,
          chatId,
          `Commands:\n/today — today's practice link\n/week — this week's test status\n/start — welcome message`
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
