/**
 * notifier.js
 * -----------
 * Wraps chrome.notifications so the rest of the code doesn't have to deal
 * with notification IDs or the click-to-open-Gmail wiring directly.
 */

// Maps a live notification ID -> the Gmail link it should open on click.
const notificationLinks = new Map();

export function notifyMatch(email, reason) {
  const notificationId = `gcw-${email.id}`;

  chrome.notifications.create(notificationId, {
    type: "basic",
    iconUrl: "icons/icon128.png",
    title: "Matched email in your inbox",
    message: `${email.subject || "(no subject)"}\nFrom: ${email.from}`,
    contextMessage: reason,
    priority: 2,
  });

  notificationLinks.set(notificationId, email.gmailLink);
}

// Registered once from background.js — opens Gmail to the matched thread.
export function registerNotificationClickHandler() {
  chrome.notifications.onClicked.addListener((notificationId) => {
    const link = notificationLinks.get(notificationId);
    if (link) {
      chrome.tabs.create({ url: link });
      chrome.notifications.clear(notificationId);
      notificationLinks.delete(notificationId);
    }
  });
}
