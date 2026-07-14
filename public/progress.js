// WonderMayank RC — shared local progress tracking
// Primary store is localStorage on this device. When signed in with Telegram, the same
// blob is also pushed/pulled from the server (D1) so progress follows you across devices.
// Loaded by index.html, practice.html, weekly-test.html, mistakes.html

const WM = (function () {
  const KEY = 'wm_rc_progress_v1';
  const TG_KEY = 'wm_rc_telegram_user';
  const CATS = ['grammar', 'vocabulary', 'rc'];
  const MIN_STREAK_FOR_TEST = 5;
  const MAX_INTERVAL_DAYS = 30;
  const MASTER_AFTER_STREAK = 3; // consecutive correct retries before a mistake is retired

  function todayIST() {
    return new Date(Date.now() + 5.5 * 60 * 60 * 1000).toISOString().slice(0, 10);
  }

  function addDays(dateStr, n) {
    const d = new Date(dateStr + 'T00:00:00Z');
    d.setUTCDate(d.getUTCDate() + n);
    return d.toISOString().slice(0, 10);
  }

  // Monday–Sunday bounds for the IST week containing dateStr — mirrors worker/index.js
  function weekBounds(dateStr) {
    const d = new Date(dateStr + 'T00:00:00Z');
    const day = d.getUTCDay();
    const diffToMonday = day === 0 ? -6 : 1 - day;
    const monday = new Date(d);
    monday.setUTCDate(d.getUTCDate() + diffToMonday);
    const sunday = new Date(monday);
    sunday.setUTCDate(monday.getUTCDate() + 6);
    return { start: monday.toISOString().slice(0, 10), end: sunday.toISOString().slice(0, 10) };
  }

  function blank() {
    return { completed: {}, mistakes: [], customPractice: {}, weeklyTests: {} };
  }

  function load() {
    try {
      const raw = localStorage.getItem(KEY);
      const parsed = raw ? JSON.parse(raw) : null;
      const b = blank();
      return parsed ? Object.assign(b, parsed) : b;
    } catch {
      return blank();
    }
  }

  function save(state) {
    try { localStorage.setItem(KEY, JSON.stringify(state)); } catch {}
    scheduleSync();
  }

  // ---------- streaks ----------

  function markCategoryDone(date, category) {
    if (!date || !CATS.includes(category)) return;
    const state = load();
    state.completed[date] = state.completed[date] || {};
    state.completed[date][category] = true;
    save(state);
  }

  function isDayFullyDone(state, date) {
    const c = state.completed[date];
    return !!c && CATS.every((cat) => c[cat]);
  }

  function currentStreak() {
    const state = load();
    let streak = 0;
    let d = todayIST();
    while (isDayFullyDone(state, d)) {
      streak++;
      const prev = new Date(d + 'T00:00:00Z');
      prev.setUTCDate(prev.getUTCDate() - 1);
      d = prev.toISOString().slice(0, 10);
    }
    return streak;
  }

  function daysCompletedThisWeek() {
    const state = load();
    const { start, end } = weekBounds(todayIST());
    let count = 0;
    const d = new Date(start + 'T00:00:00Z');
    const endD = new Date(end + 'T00:00:00Z');
    while (d <= endD) {
      if (isDayFullyDone(state, d.toISOString().slice(0, 10))) count++;
      d.setUTCDate(d.getUTCDate() + 1);
    }
    return count;
  }

  // ---------- mistakes + basic spaced repetition ----------
  // Each saved mistake carries dueDate/interval/correctStreak. Answer it right on a retry and
  // the due date jumps further out (interval doubles, capped); answer wrong and it resets to
  // "due again tomorrow". After a few clean retries in a row it's considered mastered and drops
  // off the list entirely, so mistakes don't just pile up unread forever.

  function saveMistake(q, chosenLetter, date, category) {
    if (!q || !q.id) return;
    const state = load();
    state.mistakes = state.mistakes.filter((m) => m.id !== q.id); // de-dupe, keep freshest
    state.mistakes.unshift({
      id: q.id,
      date: date || todayIST(),
      category: category || q.category || '',
      question: q.question,
      options: q.options,
      correct: q.correct,
      chosen: chosenLetter,
      explanation: q.explanation,
      topic: q.topic,
      savedAt: new Date().toISOString(),
      dueDate: todayIST(),
      interval: 1,
      correctStreak: 0,
    });
    if (state.mistakes.length > 300) state.mistakes.length = 300;
    save(state);
  }

  function getMistakes() { return load().mistakes; }

  function getDueMistakes() {
    const today = todayIST();
    return load().mistakes.filter((m) => !m.dueDate || m.dueDate <= today);
  }

  function upcomingMistakesCount() {
    const today = todayIST();
    return load().mistakes.filter((m) => m.dueDate && m.dueDate > today).length;
  }

  // Called from Retry-mode quiz after the person answers a resurfaced mistake.
  function recordMistakeRetry(id, wasCorrect) {
    const state = load();
    const idx = state.mistakes.findIndex((m) => m.id === id);
    if (idx === -1) return;
    const m = state.mistakes[idx];
    if (wasCorrect) {
      m.correctStreak = (m.correctStreak || 0) + 1;
      if (m.correctStreak >= MASTER_AFTER_STREAK) {
        state.mistakes.splice(idx, 1); // mastered — retire it
        save(state);
        return { mastered: true };
      }
      m.interval = Math.min((m.interval || 1) * 2, MAX_INTERVAL_DAYS);
      m.dueDate = addDays(todayIST(), m.interval);
    } else {
      m.correctStreak = 0;
      m.interval = 1;
      m.dueDate = todayIST(); // still due today/tomorrow, keep resurfacing
    }
    save(state);
    return { mastered: false };
  }

  function clearMistake(id) {
    const state = load();
    state.mistakes = state.mistakes.filter((m) => m.id !== id);
    save(state);
  }

  function clearAllMistakes() {
    const state = load();
    state.mistakes = [];
    save(state);
  }

  // ---------- weekly custom topic practice (once per IST week) ----------

  function canDoCustomPracticeThisWeek() {
    const state = load();
    const { start } = weekBounds(todayIST());
    return !state.customPractice[start];
  }

  function markCustomPracticeDone() {
    const state = load();
    const { start } = weekBounds(todayIST());
    state.customPractice[start] = true;
    save(state);
  }

  // ---------- weekly CBT test — one attempt per week, persisted so a refresh/reset can't retake it ----------

  function isWeeklyTestDone(weekStart) {
    const state = load();
    return !!(state.weeklyTests && state.weeklyTests[weekStart]);
  }

  function getWeeklyTestResult(weekStart) {
    const state = load();
    return (state.weeklyTests && state.weeklyTests[weekStart]) || null;
  }

  function markWeeklyTestDone(weekStart, resultSummary) {
    const state = load();
    state.weeklyTests = state.weeklyTests || {};
    state.weeklyTests[weekStart] = resultSummary;
    save(state);
  }

  // ---------- Telegram session (set after /api/auth/telegram or /api/login/status succeeds) ----------

  function getTelegramUser() {
    try {
      const raw = localStorage.getItem(TG_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch { return null; }
  }

  function setTelegramUser(user) {
    try { localStorage.setItem(TG_KEY, JSON.stringify(user)); } catch {}
    pullProgress(); // new/returning sign-in — merge in whatever the server already has
  }

  function clearTelegramUser() { localStorage.removeItem(TG_KEY); }

  // ---------- cross-device progress sync ----------
  // Signed-in users get their whole blob (completed days, mistakes, custom-practice weeks,
  // weekly-test results) mirrored to D1 keyed by telegram_id, so switching phones/laptops
  // doesn't lose a streak or re-show an already-taken weekly test.

  let syncTimer = null;
  function scheduleSync() {
    const user = getTelegramUser();
    if (!user) return;
    clearTimeout(syncTimer);
    syncTimer = setTimeout(pushProgress, 1200); // debounce rapid answer clicks into one call
  }

  async function pushProgress() {
    const user = getTelegramUser();
    if (!user) return;
    try {
      await fetch('/api/progress/sync', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ telegram_id: user.id, blob: load() }),
      });
    } catch {}
  }

  function mergeBlobs(local, remote) {
    const out = blank();
    out.completed = JSON.parse(JSON.stringify(local.completed || {}));
    for (const [date, cats] of Object.entries(remote.completed || {})) {
      out.completed[date] = Object.assign({}, out.completed[date] || {}, cats);
    }
    const byId = new Map((local.mistakes || []).map((m) => [m.id, m]));
    for (const rm of remote.mistakes || []) {
      const lm = byId.get(rm.id);
      if (!lm || new Date(rm.savedAt || 0) > new Date(lm.savedAt || 0)) byId.set(rm.id, rm);
    }
    out.mistakes = [...byId.values()].sort((a, b) => new Date(b.savedAt || 0) - new Date(a.savedAt || 0));
    out.customPractice = Object.assign({}, remote.customPractice || {}, local.customPractice || {});
    out.weeklyTests = Object.assign({}, remote.weeklyTests || {}, local.weeklyTests || {});
    return out;
  }

  async function pullProgress() {
    const user = getTelegramUser();
    if (!user) return;
    try {
      const res = await fetch('/api/progress/' + user.id);
      if (!res.ok) return;
      const data = await res.json();
      if (!data || !data.blob) { pushProgress(); return; }
      const merged = mergeBlobs(load(), data.blob);
      localStorage.setItem(KEY, JSON.stringify(merged));
      pushProgress();
    } catch {}
  }

  // ---------- one-time login code polling (bot /login and "Get a link" on the site) ----------

  async function pollLoginCode(code, onDone, opts) {
    opts = opts || {};
    const intervalMs = opts.intervalMs || 2500;
    // Must comfortably outlast the worker's LOGIN_PENDING_TTL + LOGIN_VERIFIED_TTL (5 min + 5 min)
    // — it used to be exactly 180000ms, same as the old pending TTL, so an approval near the
    // edge of that window could get claimed right as (or after) the browser gave up polling.
    const timeoutMs = opts.timeoutMs || 660000; // 11 minutes
    const start = Date.now();
    let stopped = false;
    let timer = null;

    async function check() {
      try {
        const res = await fetch('/api/login/status/' + encodeURIComponent(code));
        const data = await res.json();
        if (data.claimed && data.user) { finish(data.user); return true; }
      } catch {}
      return false;
    }

    function finish(user) {
      if (stopped) return;
      stopped = true;
      clearTimeout(timer);
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('focus', onVisible);
      onDone(user);
    }

    async function tick() {
      if (stopped) return;
      if (Date.now() - start > timeoutMs) { finish(null); return; }
      const done = await check();
      if (!done) timer = setTimeout(tick, intervalMs);
    }

    // Background/inactive tabs get their timers throttled by the browser (sometimes heavily on
    // mobile), which can delay noticing a claimed code until after it's expired. Re-check the
    // instant the tab becomes visible/focused again instead of waiting for the next throttled tick.
    function onVisible() {
      if (stopped) return;
      if (document.visibilityState && document.visibilityState !== 'visible') return;
      check();
    }
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('focus', onVisible);

    tick();
  }

  return {
    todayIST, weekBounds,
    markCategoryDone, currentStreak, daysCompletedThisWeek, MIN_STREAK_FOR_TEST,
    saveMistake, getMistakes, getDueMistakes, upcomingMistakesCount, recordMistakeRetry,
    clearMistake, clearAllMistakes,
    canDoCustomPracticeThisWeek, markCustomPracticeDone,
    isWeeklyTestDone, getWeeklyTestResult, markWeeklyTestDone,
    getTelegramUser, setTelegramUser, clearTelegramUser,
    pushProgress, pullProgress, pollLoginCode,
  };
})();
