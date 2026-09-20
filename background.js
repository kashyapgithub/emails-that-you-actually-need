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

import { findMatchingRule } from "./lib/ruleMatcher.js";
import { classifyEmail } from "./lib/aiClassifier.js";
import { notifyMatch, registerNotificationClickHandler } from "./lib/notifier.js";
import {
  getSettings,
  saveSettings,
  getRules,
  getProcessedIds,
  markProcessed,
  appendMatchLog,
} from "./lib/storage.js";

const ENSURE_TAB_ALARM = "gcw-ensure-tab";
const GMAIL_URL = "https://mail.google.com/mail/u/0/#inbox";

registerNotificationClickHandler();

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

/** Processes one batch of rows scanned from a Gmail tab. */
async function processScannedRows(rows) {
  const settings = await getSettings();
  if (!settings.isRunning) return;

  // First-ever scan: everything currently sitting in the inbox would
  // otherwise look "new" and could fire a burst of notifications for mail
  // that's been sitting there for weeks. Instead, silently record it all
  // as already-seen and start real detection from the NEXT scan onward.
  if (!settings.hasSeeded) {
    await markProcessed(rows.map((r) => r.id));
    await saveSettings({ hasSeeded: true });
    return;
  }

  const rules = await getRules();
  const processedIds = await getProcessedIds();
  const unseen = rows.filter((row) => !processedIds.has(row.id));
  if (unseen.length === 0) return;

  for (const email of unseen) {
    try {
      const matchedRule = findMatchingRule(rules, email);
      let matchReason = matchedRule
        ? `Rule match: ${matchedRule.field} ${matchedRule.match} "${matchedRule.value}"`
        : null;

      // Only spend an AI call on rows no rule already caught.
      if (!matchedRule && settings.aiFallbackEnabled && settings.aiApiKey) {
        const aiMatch = await classifyEmail(settings, email);
        if (aiMatch) matchReason = `AI match: "${settings.categoryDescription}"`;
      }

      if (matchReason) {
        notifyMatch(email, matchReason);
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
}

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === ENSURE_TAB_ALARM) ensureGmailTabOpen();
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === "GMAIL_ROWS") {
    processScannedRows(message.rows);
    return; // no response needed, content script doesn't await this
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
      await ensureGmailTabOpen();
      const tabs = await chrome.tabs.query({ url: "https://mail.google.com/*" });
      tabs.forEach((tab) => chrome.tabs.sendMessage(tab.id, { type: "SCAN_NOW" }).catch(() => {}));
      sendResponse({ ok: true, tabCount: tabs.length });
    } else if (message.type === "GET_TAB_COUNT") {
      const tabs = await chrome.tabs.query({ url: "https://mail.google.com/*" });
      sendResponse({ tabCount: tabs.length });
    }
  })();
  return true; // keep the message channel open for the async response
});

chrome.runtime.onInstalled.addListener(syncAlarm);
chrome.runtime.onStartup.addListener(syncAlarm);
