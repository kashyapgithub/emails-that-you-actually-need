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
 *     match: "contains" | "equals" | "domain",
 *     value: string,
 *     caseSensitive: boolean
 *   }>
 *   processedIds: string[]               // Gmail message IDs already checked (capped list)
 *   matchLog: Array<{ id, from, subject, matchedBy, timestamp }>  // recent hits, for the popup
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
};

const MAX_PROCESSED_IDS = 1000; // cap so storage never grows unbounded
const MAX_MATCH_LOG = 50;

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
