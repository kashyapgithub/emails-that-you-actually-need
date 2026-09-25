/**
 * storage.js
 * ----------
 * Thin wrapper around chrome.storage.local. Every other module reads/writes
 * settings through THIS file only, so the storage schema lives in one place.
 *
 * Schema (all under chrome.storage.local):
 *   settings: {
 *     pollIntervalMinutes: number,       // how often the alarm fires
 *     aiFallbackEnabled: boolean,        // use AI classifier when no rule matches
 *     aiProvider: "anthropic" | "openai",
 *     aiApiKey: string,                  // the user's own key, stored locally only
 *     aiModel: string,
 *     categoryDescription: string,       // plain-English description of what to catch
 *     isRunning: boolean                 // master on/off switch
 *     hasSeeded: boolean                 // true once the first-ever scan has been
 *                                         // baselined (see background.js) so existing
 *                                         // inbox mail never triggers a notification flood
 *   }
 *   rules: Array<{
 *     id: string,
 *     field: "from" | "subject" | "snippet",
 *     match: "contains" | "equals" | "domain" | "regex",
 *     value: string,
 *     caseSensitive: boolean,
 *     priority: "normal" | "critical",  // critical = persistent notification
 *       (stays on screen until dismissed), gold highlight in Gmail instead
 *       of red, and ALWAYS notifies even during quiet hours
 *     lastMatchedAt?: number             // timestamp of the last time this
 *       specific rule (not AI) caught something — undefined if it never has
 *   }>
 *   processedIds: string[]               // Gmail message IDs already checked (capped list)
 *   matchLog: Array<{ id, from, subject, matchedBy, timestamp }>  // recent hits, for the popup
 *   unseenCount: number                   // matches since the popup was last opened — drives the toolbar badge
 *   notificationMeta: { [notificationId]: { link, fromDomain } }  // capped map
 *     so a clicked/button-pressed notification still knows where to go and
 *     who sent it, even after the service worker has been killed and
 *     restarted by Chrome (an in-memory Map would be wiped on every restart)
 *   stats: { totalMatches: number, day: "YYYY-MM-DD", todayCount: number }
 */

const DEFAULT_SETTINGS = {
  pollIntervalMinutes: 3,
  aiFallbackEnabled: false,
  aiProvider: "anthropic",
  aiApiKey: "",
  hasSeeded: false,
  aiModel: "claude-sonnet-4-6",
  categoryDescription: "",
  isRunning: false,
  highlightInGmail: true,
  aiMatchesAreCritical: false, // if true, AI-fallback matches behave like critical rules (persistent notification, gold highlight, ignores quiet hours)
  quietHoursEnabled: false,
  quietHoursStart: "22:00",
  quietHoursEnd: "07:00",
};

const MAX_PROCESSED_IDS = 1000; // cap so storage never grows unbounded
const MAX_MATCH_LOG = 50;
const MAX_NOTIFICATION_META = 50;

export async function getSettings() {
  const { settings } = await chrome.storage.local.get("settings");
  return { ...DEFAULT_SETTINGS, ...(settings || {}) };
}

export async function saveSettings(partialSettings) {
  const current = await getSettings();
  const updated = { ...current, ...partialSettings };
  await chrome.storage.local.set({ settings: updated });
  return updated;
}

export async function getRules() {
  const { rules } = await chrome.storage.local.get("rules");
  return rules || [];
}

export async function saveRules(rules) {
  await chrome.storage.local.set({ rules });
}

/**
 * Flips a rule between normal and critical in place — added specifically
 * because without it, upgrading a rule's urgency after the fact meant
 * deleting it and recreating it from scratch, re-typing everything.
 */
export async function toggleRulePriority(ruleId) {
  const rules = await getRules();
  const updated = rules.map((r) =>
    r.id === ruleId ? { ...r, priority: r.priority === "critical" ? "normal" : "critical" } : r
  );
  await saveRules(updated);
  return updated;
}

/**
 * Stamps a rule with when it last actually caught something. Lets the
 * popup show "last matched 3h ago" (or never) next to each rule — the
 * quiet, useful signal for noticing a rule that's never firing (wrong
 * domain typo'd in, say) versus one doing real work.
 */
export async function markRuleMatched(ruleId) {
  const rules = await getRules();
  const updated = rules.map((r) => (r.id === ruleId ? { ...r, lastMatchedAt: Date.now() } : r));
  await saveRules(updated);
}

/**
 * Adds one rule, skipping it if an identical rule (same field/match/value/
 * caseSensitive) already exists. Shared by every place a single rule gets
 * created — the popup's Add button, the right-click "add sender" menu, and
 * turning a match-log entry into a rule — so the dedupe logic lives once
 * instead of being copy-pasted at each call site.
 */
export async function addRuleIfNew(candidate) {
  const rules = await getRules();
  const isDuplicate = rules.some(
    (r) =>
      r.field === candidate.field &&
      r.match === candidate.match &&
      r.value.toLowerCase() === candidate.value.toLowerCase() &&
      !!r.caseSensitive === !!candidate.caseSensitive
  );
  if (isDuplicate) return { added: false, rules };

  const newRule = {
    id: Math.random().toString(36).slice(2, 10),
    field: candidate.field,
    match: candidate.match,
    value: candidate.value,
    caseSensitive: !!candidate.caseSensitive,
    priority: candidate.priority === "critical" ? "critical" : "normal",
  };
  const updated = [...rules, newRule];
  await saveRules(updated);
  return { added: true, rules: updated, rule: newRule };
}

export async function getProcessedIds() {
  const { processedIds } = await chrome.storage.local.get("processedIds");
  return new Set(processedIds || []);
}

/**
 * Adds new message IDs to the processed set and trims it to MAX_PROCESSED_IDS
 * (oldest first) so chrome.storage.local never fills up.
 */
export async function markProcessed(newIds) {
  const existing = await getProcessedIds();
  newIds.forEach((id) => existing.add(id));
  let asArray = Array.from(existing);
  if (asArray.length > MAX_PROCESSED_IDS) {
    asArray = asArray.slice(asArray.length - MAX_PROCESSED_IDS);
  }
  await chrome.storage.local.set({ processedIds: asArray });
}

export async function getMatchLog() {
  const { matchLog } = await chrome.storage.local.get("matchLog");
  return matchLog || [];
}

export async function appendMatchLog(entry) {
  const log = await getMatchLog();
  log.unshift(entry); // newest first
  await chrome.storage.local.set({ matchLog: log.slice(0, MAX_MATCH_LOG) });
}

/** Wipes the visible match history. Doesn't touch processedIds — already-seen mail stays seen. */
export async function clearMatchLog() {
  await chrome.storage.local.set({ matchLog: [] });
}

// unseenCount lives OUTSIDE the `settings` object deliberately: settings
// changes are watched by content.js to react to isRunning/pollInterval
// changes, and every new match would otherwise trigger that listener for
// no reason, needlessly restarting its scan timer.
export async function getUnseenCount() {
  const { unseenCount } = await chrome.storage.local.get("unseenCount");
  return unseenCount || 0;
}

export async function incrementUnseenCount(by = 1) {
  const updated = (await getUnseenCount()) + by;
  await chrome.storage.local.set({ unseenCount: updated });
  return updated;
}

export async function resetUnseenCount() {
  await chrome.storage.local.set({ unseenCount: 0 });
}

/**
 * Records where a notification should navigate to on click, AND the
 * sender's domain (so the notification's action button can offer "watch
 * this sender" without needing to re-derive it later). Stored, not kept in
 * memory, specifically because Manifest V3 service workers get killed
 * after ~30s of inactivity and restarted on the next event — an in-memory
 * Map would be empty by the time a notification is actually clicked,
 * minutes or hours later, and the click/button would silently do nothing.
 */
export async function saveNotificationMeta(notificationId, meta) {
  const { notificationMeta } = await chrome.storage.local.get("notificationMeta");
  const map = notificationMeta || {};
  map[notificationId] = meta;

  // Cap it — this only needs to cover notifications a user might plausibly
  // still have sitting in their OS notification center, not forever.
  const keys = Object.keys(map); // string keys here preserve insertion order
  while (keys.length > MAX_NOTIFICATION_META) {
    delete map[keys.shift()];
  }
  await chrome.storage.local.set({ notificationMeta: map });
}

export async function getNotificationMeta(notificationId) {
  const { notificationMeta } = await chrome.storage.local.get("notificationMeta");
  return notificationMeta?.[notificationId];
}

export async function deleteNotificationMeta(notificationId) {
  const { notificationMeta } = await chrome.storage.local.get("notificationMeta");
  if (!notificationMeta || !(notificationId in notificationMeta)) return;
  delete notificationMeta[notificationId];
  await chrome.storage.local.set({ notificationMeta });
}

/**
 * Lightweight running totals for the popup's stats line. Deliberately NOT
 * derived from matchLog, which is capped at MAX_MATCH_LOG entries — a busy
 * day would silently make "today's count" wrong once the log rolled over.
 * This is its own small counter that never needs to hold historical detail,
 * just totals, so it can't be affected by the log's cap.
 */
export async function recordMatchForStats() {
  const today = new Date().toISOString().slice(0, 10);
  const { stats } = await chrome.storage.local.get("stats");
  const current = stats || { totalMatches: 0, day: today, todayCount: 0 };
  if (current.day !== today) {
    current.day = today;
    current.todayCount = 0;
  }
  current.totalMatches += 1;
  current.todayCount += 1;
  await chrome.storage.local.set({ stats: current });
  return current;
}

export async function getStats() {
  const today = new Date().toISOString().slice(0, 10);
  const { stats } = await chrome.storage.local.get("stats");
  if (!stats || stats.day !== today) return { totalMatches: stats?.totalMatches || 0, day: today, todayCount: 0 };
  return stats;
}
