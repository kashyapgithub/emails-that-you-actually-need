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
 *   1. Scan the inbox list for rows on an interval (+ a MutationObserver
 *      for near-instant pickup when Gmail injects new mail live).
 *   2. Turn each row into a plain {from, subject, snippet} object.
 *   3. Send only the NEW ones (by fingerprint) to background.js, which
 *      does the actual rule/AI matching and fires the notification.
 *
 * Note on selectors: Gmail's inbox row class (`tr.zA`) and its subject/
 * snippet/sender classes (`.bog`, `.y2`, `span[email]`) have been stable
 * for a very long time and are what most Gmail-reading extensions rely on.
 * If Google reshuffles the inbox layout, only the CSS selectors in
 * `extractRow()` below need updating — nothing else in the extension.
 */

const DEFAULT_INTERVAL_MINUTES = 3;
let scanTimer = null;

/** Small, fast, non-cryptographic hash — just enough to dedupe rows. */
function fingerprint(str) {
  let hash = 5381;
  for (let i = 0; i < str.length; i++) {
    hash = (hash * 33) ^ str.charCodeAt(i);
  }
  return (hash >>> 0).toString(36);
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

function scanInbox() {
  const rows = document.querySelectorAll("tr.zA");
  if (rows.length === 0) return; // inbox list not rendered yet (e.g. viewing a single thread)

  const found = [];
  rows.forEach((row) => {
    const email = extractRow(row);
    if (!email) return;
    const id = fingerprint(`${email.from}|${email.subject}|${email.snippet.slice(0, 40)}`);
    found.push({ id, ...email });
  });

  if (found.length > 0) {
    chrome.runtime.sendMessage({ type: "GMAIL_ROWS", rows: found }).catch(() => {
      // Background worker may be asleep/waking up — safe to ignore, next scan will retry.
    });
  }
}

function startScanning(intervalMinutes) {
  if (scanTimer) clearInterval(scanTimer);
  scanTimer = setInterval(scanInbox, Math.max(1, intervalMinutes) * 60 * 1000);
  scanInbox(); // run once immediately on load
}

// Pick up the configured interval, and react if it's changed from the popup.
chrome.storage.local.get("settings", ({ settings }) => {
  startScanning(settings?.pollIntervalMinutes || DEFAULT_INTERVAL_MINUTES);
});

chrome.storage.onChanged.addListener((changes) => {
  if (changes.settings?.newValue?.pollIntervalMinutes) {
    startScanning(changes.settings.newValue.pollIntervalMinutes);
  }
});

// Fast-path: catch new mail arriving live, without waiting for the next timer tick.
const observer = new MutationObserver(() => scanInbox());
observer.observe(document.body, { childList: true, subtree: true });

// Lets the popup's "Check now" button force an immediate scan on this tab.
chrome.runtime.onMessage.addListener((message) => {
  if (message.type === "SCAN_NOW") scanInbox();
});
