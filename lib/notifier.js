/**
 * notifier.js
 * -----------
 * Wraps chrome.notifications so the rest of the code doesn't have to deal
 * with notification IDs or the click-to-open-Gmail wiring directly.
 *
 * The click target for each notification is persisted in chrome.storage
 * (via storage.js), not kept in an in-memory variable here — a Manifest V3
 * service worker can be killed and restarted by Chrome after as little as
 * ~30 seconds of inactivity, which would silently wipe an in-memory map
 * and make clicking an older notification do nothing.
 */

import { saveNotificationLink, getNotificationLink, deleteNotificationLink } from "./storage.js";

export async function notifyMatch(email, reason) {
  const notificationId = `gcw-${email.id}`;

  chrome.notifications.create(notificationId, {
    type: "basic",
    iconUrl: "icons/icon128.png",
    title: "Matched email in your inbox",
    message: `${email.subject || "(no subject)"}\nFrom: ${email.from}`,
    contextMessage: reason,
    priority: 2,
  });

  await saveNotificationLink(notificationId, email.gmailLink);
}

// Registered once from background.js — opens Gmail to the matched thread.
export function registerNotificationClickHandler() {
  chrome.notifications.onClicked.addListener(async (notificationId) => {
    const link = await getNotificationLink(notificationId);
    if (link) {
      chrome.tabs.create({ url: link });
      chrome.notifications.clear(notificationId);
      await deleteNotificationLink(notificationId);
    }
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
