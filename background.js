/**
 * background.js
 * -------------
 * The extension's service worker. With no Gmail API involved, its jobs are:
 *   1. Make sure a Gmail tab exists to scan (auto-opens a pinned one if
 *      none is found, so the user never has to remember to open Gmail).
 *   2. Receive scanned rows from content.js, run them through the rule
 *      matcher (and AI fallback if enabled), and fire notifications.
 *
 * All matching/AI/notification logic lives in lib/*.js — this file is
 * just the orchestration glue.
 */

import { findMatchingRule, describeRule } from "./lib/ruleMatcher.js";
import { classifyEmail } from "./lib/aiClassifier.js";
import { notifyMatch, registerNotificationClickHandler, updateBadge } from "./lib/notifier.js";
import {
  getSettings,
  saveSettings,
  getRules,
  getProcessedIds,
  markProcessed,
  appendMatchLog,
  incrementUnseenCount,
  addRuleIfNew,
} from "./lib/storage.js";

const CONTEXT_MENU_ID = "gcw-add-sender-rule";

const ENSURE_TAB_ALARM = "gcw-ensure-tab";
const GMAIL_URL = "https://mail.google.com/mail/u/0/#inbox";

registerNotificationClickHandler();

/**
 * Right-click "add rule" straight from Gmail: select a sender's name or
 * address in any inbox row, right-click, one click adds a rule — no popup,
 * no dropdowns, no typing. This is the single biggest interaction-speed
 * win available here, since it turns the most common action (watch this
 * sender) from ~5 steps in the popup into 2 clicks in the page you're
 * already looking at.
 */
function setUpContextMenu() {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: CONTEXT_MENU_ID,
      title: 'Add "%s" as a watch rule',
      contexts: ["selection"],
      documentUrlPatterns: ["https://mail.google.com/*"],
    });
  });
}

chrome.contextMenus.onClicked.addListener(async (info) => {
  if (info.menuItemId !== CONTEXT_MENU_ID) return;
  const text = (info.selectionText || "").trim();
  if (!text) return;

  // If the selection looks like an email address, prefer a domain rule
  // (catches every sender at that company, which is what "watch this
  // sender" usually means for a broker/bank alert address). Otherwise
  // fall back to matching the selected text against the From field
  // (useful for selecting just a display name like "Zerodha Kite").
  const emailMatch = text.match(/[\w.+-]+@([\w-]+\.[\w.-]+)/);
  const rule = emailMatch
    ? { field: "from", match: "domain", value: emailMatch[1].toLowerCase(), caseSensitive: false }
    : { field: "from", match: "contains", value: text, caseSensitive: false };

  const { added } = await addRuleIfNew(rule);

  // A quick, self-dismissing confirmation — distinct notification ID prefix
  // from real matches (`gcw-<id>`) so it can never collide with one.
  chrome.notifications.create(`gcw-confirm-${Date.now()}`, {
    type: "basic",
    iconUrl: "icons/icon128.png",
    title: added ? "Rule added" : "Already watching this",
    message: describeRule(rule),
    priority: 0,
  });
});

/** Opens a pinned, non-focused Gmail tab if the user doesn't already have one open. */
async function ensureGmailTabOpen() {
  const settings = await getSettings();
  if (!settings.isRunning) return;

  const tabs = await chrome.tabs.query({ url: "https://mail.google.com/*" });
  if (tabs.length === 0) {
    await chrome.tabs.create({ url: GMAIL_URL, pinned: true, active: false });
  }
}

async function syncAlarm() {
  const settings = await getSettings();
  await chrome.alarms.clear(ENSURE_TAB_ALARM);
  if (settings.isRunning) {
    // Just needs to be frequent enough to notice a closed tab reasonably fast;
    // the actual mail-scanning cadence is controlled by content.js itself.
    chrome.alarms.create(ENSURE_TAB_ALARM, { periodInMinutes: 2 });
    ensureGmailTabOpen();
  }
}

/**
 * The actual processing logic for one batch of scanned rows. NOT exported
 * directly — see `processScannedRows` below, which serializes calls to
 * this function through a queue so two overlapping batches can never both
 * read "not yet processed" for the same email at once (that race used to
 * cause duplicate AI calls and duplicate match-log entries).
 */
async function processScannedRowsInternal(rows) {
  const settings = await getSettings();
  if (!settings.isRunning) return { matched: 0 };

  // First-ever scan: everything currently sitting in the inbox would
  // otherwise look "new" and could fire a burst of notifications for mail
  // that's been sitting there for weeks. Instead, silently record it all
  // as already-seen and start real detection from the NEXT scan onward.
  if (!settings.hasSeeded) {
    await markProcessed(rows.map((r) => r.id));
    await saveSettings({ hasSeeded: true });
    return { matched: 0, seeded: true };
  }

  const rules = await getRules();
  const processedIds = await getProcessedIds();
  const unseen = rows.filter((row) => !processedIds.has(row.id));
  if (unseen.length === 0) return { matched: 0 };

  // Only spend an AI call when there's actually something to check against —
  // an empty category description would otherwise silently burn an API call
  // per email asking "does this match ''", which is both useless and costs money.
  const aiFallbackUsable =
    settings.aiFallbackEnabled &&
    !!settings.aiApiKey &&
    settings.categoryDescription.trim().length > 0;

  let matchedCount = 0;
  const matchedRows = []; // {id, matchedBy} for every real match this batch — used to flag rows live in Gmail

  for (const email of unseen) {
    try {
      const matchedRule = findMatchingRule(rules, email);
      let matchReason = matchedRule ? `Rule match: ${describeRule(matchedRule)}` : null;

      if (!matchedRule && aiFallbackUsable) {
        const aiMatch = await classifyEmail(settings, email);
        if (aiMatch) matchReason = `AI match: "${settings.categoryDescription}"`;
      }

      if (matchReason) {
        matchedCount++;
        matchedRows.push({ id: email.id, matchedBy: matchReason });
        await notifyMatch(email, matchReason);
        await appendMatchLog({
          id: email.id,
          from: email.from,
          subject: email.subject,
          matchedBy: matchReason,
          timestamp: Date.now(),
        });
      }
    } catch (err) {
      console.error("[Gmail Category Watcher] Error processing a row:", err.message);
    }
  }

  await markProcessed(unseen.map((r) => r.id));

  if (matchedCount > 0) {
    const total = await incrementUnseenCount(matchedCount);
    await updateBadge(total);
  }

  return { matched: matchedCount, matchedRows };
}

// A single promise chain that every batch of rows gets appended to, so
// batches are always processed one at a time, in arrival order — never
// concurrently. Without this, two scans landing close together (very
// possible now that Gmail's own DOM churn can trigger scans) could both
// read the "not yet seen" list before either had written to it, letting
// the same new email slip through as "unseen" twice: two AI calls, two
// match-log entries, for one email.
let processingQueue = Promise.resolve({ matched: 0, matchedRows: [] });
function processScannedRows(rows) {
  processingQueue = processingQueue
    .catch(() => {}) // don't let one bad batch break the chain for future batches
    .then(() => processScannedRowsInternal(rows));
  return processingQueue;
}

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === ENSURE_TAB_ALARM) ensureGmailTabOpen();
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === "GMAIL_ROWS") {
    // Fire-and-forget from content.js's perspective, but once processing
    // actually finishes, push back which rows matched so that tab can
    // flag them live in the inbox — the visual "wow" companion to the
    // notification, not a replacement for it.
    const tabId = sender.tab?.id;
    processScannedRows(message.rows).then(async (result) => {
      if (!tabId || !result.matchedRows?.length) return;
      const settings = await getSettings();
      if (settings.highlightInGmail === false) return;
      chrome.tabs.sendMessage(tabId, { type: "HIGHLIGHT_MATCHES", matches: result.matchedRows }).catch(() => {});
    });
    return;
  }

  (async () => {
    if (message.type === "SET_RUNNING") {
      await saveSettings({ isRunning: message.value });
      await syncAlarm();
      sendResponse({ ok: true });
    } else if (message.type === "SYNC_ALARM") {
      await syncAlarm();
      sendResponse({ ok: true });
    } else if (message.type === "CHECK_NOW") {
      const settings = await getSettings();
      if (!settings.isRunning) {
        // Watching is off — "Check now" doing a full match/notify pass while
        // the master switch is off would be a silent contradiction. The
        // popup disables this button when off, but guard here too in case
        // this message ever arrives from anywhere else.
        sendResponse({ ok: false, reason: "not_running", tabCount: 0 });
        return;
      }

      await ensureGmailTabOpen();
      const tabs = await chrome.tabs.query({ url: "https://mail.google.com/*" });

      // Ask every open Gmail tab to scan and hand back its rows directly,
      // then actually wait for the full match/AI/notify pass to finish
      // before responding — so the popup's "Checking…" state reflects
      // real completion instead of a guessed timeout.
      const responses = await Promise.all(
        tabs.map((tab) =>
          chrome.tabs.sendMessage(tab.id, { type: "SCAN_NOW" }).catch(() => null)
        )
      );
      const allRows = responses.filter(Boolean).flatMap((r) => r.rows || []);
      const result = await processScannedRows(allRows);

      if (result.matchedRows?.length && settings.highlightInGmail !== false) {
        tabs.forEach((tab) =>
          chrome.tabs.sendMessage(tab.id, { type: "HIGHLIGHT_MATCHES", matches: result.matchedRows }).catch(() => {})
        );
      }

      sendResponse({ ok: true, tabCount: tabs.length, matched: result.matched });
    } else if (message.type === "GET_TAB_COUNT") {
      const tabs = await chrome.tabs.query({ url: "https://mail.google.com/*" });
      // A tab "counts" as watching only if it's actually showing the inbox —
      // a Gmail tab parked on Sent/Drafts/a label isn't contributing any
      // scans, and the popup should say so rather than just "1 tab open."
      const inboxTabCount = tabs.filter((tab) => {
        const hash = new URL(tab.url).hash;
        return hash === "" || hash.startsWith("#inbox");
      }).length;
      sendResponse({ tabCount: tabs.length, inboxTabCount });
    } else if (message.type === "GET_CURRENT_INBOX_ROWS") {
      // Used by the popup's "Preview matches" button — deliberately read-only:
      // it fetches the currently visible rows WITHOUT marking them as seen or
      // running them through processScannedRows, so testing a draft rule can
      // never suppress a real future notification for that same email.
      const tabs = await chrome.tabs.query({ url: "https://mail.google.com/*" });
      const responses = await Promise.all(
        tabs.map((tab) =>
          chrome.tabs.sendMessage(tab.id, { type: "SCAN_NOW" }).catch(() => null)
        )
      );
      const rows = responses.filter(Boolean).flatMap((r) => r.rows || []);
      sendResponse({ rows, tabCount: tabs.length });
    }
  })();
  return true; // keep the message channel open for the async response
});

chrome.runtime.onInstalled.addListener(() => {
  syncAlarm();
  setUpContextMenu();
});
chrome.runtime.onStartup.addListener(() => {
  syncAlarm();
  setUpContextMenu();
});
