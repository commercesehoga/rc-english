// WonderMayank RC — shared local progress tracking
// Everything here lives in localStorage on this device only (no login required).
// Loaded by index.html, practice.html, weekly-test.html, mistakes.html

const WM = (function () {
  const KEY = 'wm_rc_progress_v1';
  const TG_KEY = 'wm_rc_telegram_user';
  const CATS = ['grammar', 'vocabulary', 'rc'];
  const MIN_STREAK_FOR_TEST = 5;

  function todayIST() {
    return new Date(Date.now() + 5.5 * 60 * 60 * 1000).toISOString().slice(0, 10);
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

  function load() {
    try {
      const raw = localStorage.getItem(KEY);
      const parsed = raw ? JSON.parse(raw) : null;
      return parsed || { completed: {}, mistakes: [], customPractice: {} };
    } catch {
      return { completed: {}, mistakes: [], customPractice: {} };
    }
  }

  function save(state) {
    try { localStorage.setItem(KEY, JSON.stringify(state)); } catch {}
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

  // ---------- mistakes ----------

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
    });
    if (state.mistakes.length > 300) state.mistakes.length = 300;
    save(state);
  }

  function getMistakes() { return load().mistakes; }

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

  // ---------- Telegram session (set after /api/auth/telegram succeeds) ----------

  function getTelegramUser() {
    try {
      const raw = localStorage.getItem(TG_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch { return null; }
  }

  function setTelegramUser(user) {
    try { localStorage.setItem(TG_KEY, JSON.stringify(user)); } catch {}
  }

  function clearTelegramUser() { localStorage.removeItem(TG_KEY); }

  return {
    todayIST, weekBounds,
    markCategoryDone, currentStreak, daysCompletedThisWeek, MIN_STREAK_FOR_TEST,
    saveMistake, getMistakes, clearMistake, clearAllMistakes,
    canDoCustomPracticeThisWeek, markCustomPracticeDone,
    getTelegramUser, setTelegramUser, clearTelegramUser,
  };
})();
