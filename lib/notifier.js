/**
 * notifier.js
 * -----------
 * Wraps chrome.notifications so the rest of the code doesn't have to deal
 * with notification IDs, click-to-open wiring, or the action button
 * directly.
 *
 * Every notification's metadata (where to navigate, whose domain to offer
 * as a rule) is persisted via storage.js, not kept in an in-memory
 * variable — a Manifest V3 service worker can be killed and restarted by
 * Chrome after as little as ~30 seconds of inactivity, which would
 * silently wipe an in-memory map and make clicking/acting on an older
 * notification do nothing.
 */

import {
  saveNotificationMeta,
  getNotificationMeta,
  deleteNotificationMeta,
  addRuleIfNew,
} from "./storage.js";
import { extractDomain, describeRule } from "./ruleMatcher.js";

const ADD_RULE_BUTTON_INDEX = 0;

/**
 * priority: "normal" | "critical". Critical notifications use
 * requireInteraction so they stay on screen until the person actually
 * dismisses them, instead of the OS auto-clearing them after a few
 * seconds — appropriate for something like a margin call, wrong for a
 * routine invoice.
 */
export async function notifyMatch(email, reason, priority = "normal") {
  const notificationId = `gcw-${email.id}`;
  const fromDomain = extractDomain(email.from);

  chrome.notifications.create(notificationId, {
    type: "basic",
    iconUrl: "icons/icon128.png",
    title: priority === "critical" ? "🔴 Critical match in your inbox" : "Matched email in your inbox",
    message: `${email.subject || "(no subject)"}\nFrom: ${email.from}`,
    contextMessage: reason,
    priority: priority === "critical" ? 2 : 1,
    requireInteraction: priority === "critical",
    // Only offered when a domain could actually be extracted from the
    // sender — always true in practice for real email addresses.
    buttons: fromDomain ? [{ title: `+ Watch every email from ${fromDomain}` }] : undefined,
  });

  await saveNotificationMeta(notificationId, { link: email.gmailLink, fromDomain });
}

// Registered once from background.js.
export function registerNotificationClickHandler() {
  chrome.notifications.onClicked.addListener(async (notificationId) => {
    const meta = await getNotificationMeta(notificationId);
    if (meta?.link) {
      chrome.tabs.create({ url: meta.link });
      chrome.notifications.clear(notificationId);
      await deleteNotificationMeta(notificationId);
    }
  });

  // The action button lets someone turn "this one email matched" into "now
  // watch this sender forever" without ever opening the popup — the same
  // one-click promotion the match log offers, just one step earlier.
  chrome.notifications.onButtonClicked.addListener(async (notificationId, buttonIndex) => {
    if (buttonIndex !== ADD_RULE_BUTTON_INDEX) return;
    const meta = await getNotificationMeta(notificationId);
    if (!meta?.fromDomain) return;

    const rule = { field: "from", match: "domain", value: meta.fromDomain, caseSensitive: false };
    const { added } = await addRuleIfNew(rule);

    chrome.notifications.clear(notificationId);
    await deleteNotificationMeta(notificationId);

    chrome.notifications.create(`gcw-confirm-${Date.now()}`, {
      type: "basic",
      iconUrl: "icons/icon128.png",
      title: added ? "Rule added" : "Already watching this",
      message: describeRule(rule),
      priority: 0,
    });
  });
}

/**
 * Shows/clears the small red count on the toolbar icon — a way to see
 * "something matched" at a glance without opening the popup. Cleared by
 * the popup itself the moment it's opened (see popup.js), same pattern as
 * an unread-messages badge.
 */
export async function updateBadge(count) {
  await chrome.action.setBadgeText({ text: count > 0 ? String(count) : "" });
  await chrome.action.setBadgeBackgroundColor({ color: "#d32f2f" });
}
