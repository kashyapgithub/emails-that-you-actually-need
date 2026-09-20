# Gmail Category Watcher

A Chrome extension that watches your inbox and notifies you the moment an
email matches a category you define — either by simple rules
(sender/subject/keyword) or, if none of those catch it, an AI fallback that
judges the email against a plain-English description you write.

No Google sign-in, no API keys to set up, no Google Cloud project. It reads
your inbox the same way your eyes would — off the Gmail page itself.

## Setup (2 minutes)

1. Go to `chrome://extensions`
2. Turn on **Developer mode** (top-right toggle)
3. Click **Load unpacked** → select this `gmail-category-watcher` folder
4. Click the extension's icon in the toolbar, add a rule or two, and flip
   the toggle on

That's it. If you don't already have a Gmail tab open, the extension opens
a pinned one for you automatically.

## How it works

- A small script runs only on `mail.google.com` and reads the inbox list
  that's already rendered on the page — sender, subject, and preview text.
  It never logs in, authenticates, or touches anything outside that one
  page, and it only reads — it never clicks, deletes, or sends anything.
- Every few minutes (configurable in the popup) it checks for new rows and
  reports the ones it hasn't seen before.
- Each new email is checked against your rules first (free, instant). Only
  if nothing matches, and you've turned on AI fallback with an API key, does
  it get sent — just the subject + preview, never the full body — to your
  chosen provider for a fuzzy yes/no classification against the category
  you described. Supported providers: **Anthropic (Claude)**, **OpenAI**,
  **Google (Gemini)**, and **OpenRouter** (which can route to almost any
  model — just use the provider-prefixed model name it expects, e.g.
  `anthropic/claude-3.5-haiku` or `meta-llama/llama-3.1-8b-instruct`).
- A match fires a native desktop notification; clicking it opens that
  email in Gmail.

## Things worth knowing

- **Needs a Gmail tab open — doesn't need to be the focused one.** The
  extension keeps a pinned background tab automatically; it doesn't have to
  be the tab you're actively looking at.
- **It only sees the current page of your inbox list.** Gmail renders
  roughly 50 conversations per page (configurable in Gmail's own settings
  up to 100) — the extension reads whatever's currently rendered, not your
  whole mailbox. This is not a limitation in practice: new mail always
  appears at the top of page one, so it's always visible to the next scan.
- **It only reads the inbox view/tab that's currently open in that tab.**
  If you use Gmail's Primary/Social/Promotions/Updates category tabs, only
  the one currently on screen gets scanned. If you want full coverage,
  turn off Categories in Gmail Settings → Inbox, so everything lives in one
  unified list.
- **The first scan after install/enable is a baseline, not a check.**
  Whatever's already sitting in your inbox on that very first scan is
  recorded as "already seen" without generating any notifications — so
  turning this on doesn't dump every old matching email on you at once.
  Detection starts fresh from the next scan onward.
- **DOM-based, not API-based.** This trades the (real) hassle of Google
  Cloud OAuth setup for a small risk: if Google redesigns the Gmail inbox
  layout, the row-reading selectors in `content.js` may need a small
  update. That logic lives in one function (`extractRow`) so it's a quick
  fix if it ever happens.
- Your AI API key (if you use the fallback) is stored only in
  `chrome.storage.local` on your machine, and is only ever sent to the
  provider you picked.
