/**
 * content.js
 * ----------
 * Runs directly on mail.google.com — this is the whole reason no sign-in
 * step is needed. It never touches the Gmail API; it just reads the inbox
 * rows that are already rendered on the page you're logged into, the same
 * way a person reading their inbox would.
 *
 * It only ever READS the page. It never clicks, deletes, or sends anything.
 *
 * Responsibilities:
 *   1. Scan the inbox list on an interval, ONLY while watching is turned on.
 *   2. Also catch new mail arriving live via a MutationObserver — debounced,
 *      so Gmail's constant background DOM churn (read receipts, hover
 *      states, unread counters) doesn't trigger dozens of rescans a minute.
 *   3. Turn each row into a plain {from, subject, snippet} object and send
 *      only the current set to background.js, which does the actual
 *      dedupe + rule/AI matching + notification.
 *
 * Note on selectors: Gmail's inbox row class (`tr.zA`) and its subject/
 * snippet/sender classes (`.bog`, `.y2`, `span[email]`) have been stable
 * for a very long time and are what most Gmail-reading extensions rely on.
 * If Google reshuffles the inbox layout, only the CSS selectors in
 * `extractRow()` below need updating — nothing else in the extension.
 */

const DEFAULT_INTERVAL_MINUTES = 3;
const MUTATION_DEBOUNCE_MS = 2000; // coalesce bursts of Gmail's own DOM churn into one scan

let scanTimer = null;
let isRunning = false; // mirrors settings.isRunning — the master on/off switch

/** Small, fast, non-cryptographic hash — just enough to dedupe rows. */
function fingerprint(str) {
  let hash = 5381;
  for (let i = 0; i < str.length; i++) {
    hash = (hash * 33) ^ str.charCodeAt(i);
  }
  return (hash >>> 0).toString(36);
}

/** Generic debounce: collapses rapid repeated calls into one, after `wait` ms of quiet. */
function debounce(fn, wait) {
  let timer = null;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), wait);
  };
}

/** Pulls {from, subject, snippet, gmailLink} out of one inbox row, or null if the row doesn't look like a normal message row. */
function extractRow(row) {
  try {
    const senderEl = row.querySelector("span[email]");
    const subjectEl = row.querySelector(".bog");
    const snippetEl = row.querySelector(".y2");

    if (!senderEl || !subjectEl) return null; // not a real message row

    const from = senderEl.getAttribute("email") || senderEl.textContent.trim();
    const subject = subjectEl.textContent.trim();
    const snippet = snippetEl ? snippetEl.textContent.trim() : "";
    const threadId = row.getAttribute("data-legacy-thread-id");
    const gmailLink = threadId
      ? `https://mail.google.com/mail/u/0/#inbox/${threadId}`
      : "https://mail.google.com/mail/u/0/#inbox";

    return { from, subject, snippet, gmailLink };
  } catch {
    return null;
  }
}

/** Pure DOM read: returns the current inbox rows as plain objects. No messaging, no side effects. */
function collectRows() {
  const rows = document.querySelectorAll("tr.zA");
  const found = [];
  rows.forEach((row) => {
    const email = extractRow(row);
    if (!email) return;
    const id = fingerprint(`${email.from}|${email.subject}|${email.snippet.slice(0, 40)}`);
    found.push({ id, ...email });
  });
  return found;
}

function scanInbox() {
  if (!isRunning) return; // master switch is off — do nothing, not even a DOM query
  const found = collectRows();
  if (found.length > 0) {
    chrome.runtime.sendMessage({ type: "GMAIL_ROWS", rows: found }).catch(() => {
      // Background worker may be asleep/waking up — safe to ignore, next scan will retry.
    });
  }
}

const debouncedScan = debounce(scanInbox, MUTATION_DEBOUNCE_MS);

function stopScanning() {
  if (scanTimer) {
    clearInterval(scanTimer);
    scanTimer = null;
  }
}

function startScanning(intervalMinutes) {
  stopScanning();
  scanTimer = setInterval(scanInbox, Math.max(1, intervalMinutes) * 60 * 1000);
  scanInbox(); // run once immediately
}

/** Applies the current settings: starts/stops the timer and updates the isRunning flag used everywhere above. */
function applySettings(settings) {
  isRunning = !!settings?.isRunning;
  if (isRunning) {
    startScanning(settings?.pollIntervalMinutes || DEFAULT_INTERVAL_MINUTES);
  } else {
    stopScanning(); // no point polling a DOM we're not allowed to act on
  }
}

chrome.storage.local.get("settings", ({ settings }) => applySettings(settings));

chrome.storage.onChanged.addListener((changes) => {
  if (changes.settings) applySettings(changes.settings.newValue);
});

// Fast-path: catch new mail arriving live, without waiting for the next timer
// tick — debounced so Gmail's own constant DOM churn doesn't cause a rescan
// storm (this was previously unthrottled and was the single biggest resource
// and correctness problem in this file).
const observer = new MutationObserver(() => debouncedScan());
observer.observe(document.body, { childList: true, subtree: true });

// Lets the popup's "Check now" button force an immediate scan on this tab and
// get the result back directly, so the popup can show a result that reflects
// what actually happened rather than guessing with a timer.
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === "SCAN_NOW") {
    sendResponse({ rows: collectRows() });
  }
});
