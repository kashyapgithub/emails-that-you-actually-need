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
let highlightEnabled = true; // mirrors settings.highlightInGmail

// Tracks id -> the actual DOM row element from the most recent scan, so
// that when background.js reports back "these IDs just matched," we can
// find and visually flag the right rows directly in Gmail's own inbox —
// rebuilt fresh on every scan since Gmail can replace row elements outright.
let lastRowElementsById = new Map();

/**
 * Injects the pulse animation once. Using a real CSS @keyframes animation
 * (rather than a static color) is what makes a fresh match feel like it
 * just *happened* — a warm flash that settles into a steady tinted state —
 * instead of a static tag that's easy to miss scrolling past.
 */
function injectHighlightStyles() {
  if (document.getElementById("gcw-highlight-styles")) return;
  const style = document.createElement("style");
  style.id = "gcw-highlight-styles";
  style.textContent = `
    @keyframes gcw-pulse {
      0%   { background-color: rgba(211, 47, 47, 0.35); }
      100% { background-color: rgba(211, 47, 47, 0.07); }
    }
    @keyframes gcw-pulse-critical {
      0%   { background-color: rgba(245, 124, 0, 0.55); }
      50%  { background-color: rgba(245, 124, 0, 0.25); }
      100% { background-color: rgba(245, 124, 0, 0.12); }
    }
    tr.gcw-matched-row {
      animation: gcw-pulse 1.8s ease-out;
      background-color: rgba(211, 47, 47, 0.07) !important;
      box-shadow: inset 4px 0 0 0 #d32f2f !important;
    }
    tr.gcw-matched-row-critical {
      animation: gcw-pulse-critical 2.4s ease-in-out 2;
      background-color: rgba(245, 124, 0, 0.12) !important;
      box-shadow: inset 4px 0 0 0 #f57c00 !important;
    }
  `;
  document.documentElement.appendChild(style);
}

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
  const elementMap = new Map();
  rows.forEach((row) => {
    const email = extractRow(row);
    if (!email) return;
    // The ID needs to survive two competing failure modes:
    //  1. Two DIFFERENT threads with near-identical templated content (very
    //     common for repeated trading/order-status alerts) must not hash to
    //     the same ID — that would silently swallow the second one.
    //  2. Multiple DIFFERENT messages that Gmail groups into the SAME
    //     thread (e.g. "Order Placed" -> "Order Executed" -> "Order
    //     Cancelled", all sharing a subject) must NOT collapse into one ID
    //     either — that would mean only the first message in a thread ever
    //     notifies, and every real update after it goes silent.
    // Folding the thread ID into the same hash as the content solves both:
    // different threads never collide even with identical content, and
    // different content within the same thread still produces different
    // IDs. Only a truly identical row re-read on a later scan (the actual
    // "already seen this" case) hashes the same, which is what we want.
    const id = fingerprint(
      `${row.getAttribute("data-legacy-thread-id") || ""}|${email.from}|${email.subject}|${email.snippet.slice(0, 40)}`
    );
    found.push({ id, ...email });
    elementMap.set(id, row);
  });
  lastRowElementsById = elementMap;
  return found;
}

/**
 * Flags rows directly in Gmail's own inbox — the "wow" feature. background.js
 * calls this (via a message) right after it decides an email is a genuine
 * new match, passing back only the IDs that matched and why.
 *
 * Deliberately minimal-risk: this only ever sets a className and a title
 * attribute on the <tr> itself — never innerHTML, never a child insertion —
 * so there's no way it can interfere with Gmail's own click handlers or
 * layout. `row.title` gives a free native tooltip explaining the match on
 * hover, no custom positioning code needed.
 *
 * One honest limitation: if Gmail later replaces this row's DOM element
 * outright (e.g. a full list re-render), the highlight won't follow it —
 * this is a "this just happened" flash, not a persisted state indicator.
 * The notification and match log remain the durable record either way.
 */
function highlightMatches(matches) {
  if (!highlightEnabled) return;
  injectHighlightStyles();
  matches.forEach(({ id, matchedBy, priority }) => {
    const row = lastRowElementsById.get(id);
    if (!row) return;
    row.classList.add(priority === "critical" ? "gcw-matched-row-critical" : "gcw-matched-row");
    row.title = `Gmail Category Watcher${priority === "critical" ? " (critical)" : ""}: ${matchedBy}`;
  });
}

/**
 * Gmail's URL hash tells us which view is on screen — "#inbox" (including
 * "#inbox/<threadId>" when a single thread is open) for the inbox, but
 * "#sent", "#drafts", "#label/x", "#search/..." etc. for everything else.
 * Category tabs (Primary/Social/Promotions) don't change the hash, so this
 * doesn't interfere with that separate, already-documented limitation.
 *
 * Without this check, if the pinned Gmail tab ever gets navigated away from
 * the inbox — a stray click, a bookmark, anything — scanning would keep
 * silently reading whatever's on screen instead, while the popup still
 * claimed to be "watching."
 */
function isOnInboxView() {
  const hash = location.hash;
  return hash === "" || hash.startsWith("#inbox");
}

function scanInbox() {
  if (!isRunning) return; // master switch is off — do nothing, not even a DOM query
  if (!isOnInboxView()) return; // this tab has navigated away from the inbox — nothing to read
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
  highlightEnabled = settings?.highlightInGmail !== false; // default on
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
/**
 * Reports what this content script can actually see on the page right now.
 * Exists because the extension's biggest silent-failure risk is Gmail
 * changing the markup the selectors depend on: if `tr.zA` stops matching,
 * nothing crashes, it just never finds any mail. This lets you find out in
 * one click instead of wondering why nothing ever notifies.
 *
 * Sample text is truncated, and the popup renders it with textContent, so
 * nothing from an email is ever interpreted as markup.
 */
function buildDiagnosticReport() {
  const rowEls = document.querySelectorAll("tr.zA");
  let parsedCount = 0;
  let withThreadId = 0;
  let sample = null;

  rowEls.forEach((row) => {
    const parsed = extractRow(row);
    if (!parsed) return;
    parsedCount++;
    if (row.getAttribute("data-legacy-thread-id")) withThreadId++;
    if (!sample) {
      sample = {
        from: parsed.from.slice(0, 60),
        subject: parsed.subject.slice(0, 60),
        snippet: parsed.snippet.slice(0, 60),
      };
    }
  });

  return {
    hash: location.hash || "(none)",
    onInboxView: isOnInboxView(),
    isRunning,
    rowElementsFound: rowEls.length,
    rowsParsed: parsedCount,
    rowsWithThreadId: withThreadId,
    sample,
  };
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === "SCAN_NOW") {
    sendResponse({ rows: isOnInboxView() ? collectRows() : [], onInboxView: isOnInboxView() });
  } else if (message.type === "DIAGNOSE") {
    sendResponse(buildDiagnosticReport());
  } else if (message.type === "HIGHLIGHT_MATCHES") {
    highlightMatches(message.matches || []);
  }
});
