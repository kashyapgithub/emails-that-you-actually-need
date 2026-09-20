<div align="center">

# 📬 Gmail Category Watcher

**Tell it what kind of email matters. It watches your inbox and pings you the moment one shows up.**

No OAuth. No Google Cloud project. No API dashboard tour. Load it and it works.

![Manifest V3](https://img.shields.io/badge/manifest-v3-4285F4?logo=googlechrome&logoColor=white)
![Zero OAuth](https://img.shields.io/badge/setup-zero%20OAuth-2e7d32)
![AI Providers](https://img.shields.io/badge/AI-Claude%20%7C%20OpenAI%20%7C%20Gemini%20%7C%20OpenRouter-6f42c1)
![License: MIT](https://img.shields.io/badge/license-MIT-yellow)

</div>

---

> [!IMPORTANT]
> **Requires one Gmail tab to be open** (it doesn't need to be the active/
> focused tab — a pinned background tab is fine). This extension has no
> access to Gmail's servers; it reads the inbox off the page itself, so if
> every Gmail tab is closed, there's nothing for it to read and watching
> pauses until one is open again. If none is open when you flip watching
> on, it opens a pinned one for you automatically — see [Requirements](#requirements).

## The problem this solves

Your inbox has exactly one email you actually need to see today, buried under
forty you don't. Gmail's own filters only understand exact keywords. Zapier/
Make.com want you to wire up a scenario and pay per run. The "proper" way —
the Gmail API — wants an OAuth consent screen, a Google Cloud project, a
verified app, and twenty minutes you don't have.

This skips all of it. It reads your inbox the same way *you* do — off the
rendered page — and decides what's worth a notification using either plain
rules or an AI's judgment call.

## How it works

```mermaid
flowchart LR
    A["📄 content.js<br/>reads the Gmail DOM"] -->|new rows| B["⚙️ background.js<br/>service worker"]
    B --> C{Rule match?}
    C -->|Yes| E["🔔 Notify"]
    C -->|No, AI fallback on| D["🤖 AI classifier<br/>Claude · GPT · Gemini · OpenRouter"]
    D -->|Match| E
    D -->|No match| F["Ignore"]
    E --> G["Chrome notification<br/>click → opens the email"]
```

Nothing here logs in, authenticates, or touches Gmail's servers directly —
`content.js` only ever *reads* the page you're already signed into.

## Features

| | |
|---|---|
| 🚫 **Zero setup** | Load unpacked, done. No client IDs, no consent screens. |
| 🎯 **Rule matching** | From / Subject / Body — contains, exact match, or sender domain |
| 🤖 **AI fallback** | Fuzzy category matching in plain English, when keywords aren't enough |
| 🔌 **4 AI providers** | Anthropic, OpenAI, Gemini, OpenRouter — bring your own key |
| 🧠 **Smart baseline** | First scan never floods you with notifications for mail already sitting there |
| 🪶 **Lightweight** | Polls a page, not an API. No servers, no infra, no bill until you opt into AI |
| 🔒 **Reads only** | Never clicks, deletes, sends, or modifies anything |

## Requirements

- **Google Chrome** (or any Chromium browser that supports Manifest V3 —
  Edge, Brave, etc.)
- **One Gmail tab open, at all times, while watching is on.** This is the
  trade-off for skipping OAuth entirely: there's no server-side connection
  to your inbox, so the extension can only see mail when a Gmail tab exists
  for it to read from. Practically, this is a non-issue —
  - it auto-opens a **pinned** tab for you if none exists when you turn
    watching on
  - that tab does **not** need focus — it can sit pinned in the background
    while you work in other tabs
  - if you close *every* Gmail tab, watching simply pauses (no crash, no
    error) until one exists again — reopening one, or clicking **Check
    now** in the popup, picks detection back up immediately

## Setup (2 minutes, seriously)

1. `chrome://extensions` → toggle **Developer mode** (top-right)
2. **Load unpacked** → select this folder
3. Click the toolbar icon → add a rule → flip the toggle on

See [Requirements](#requirements) for the one thing this needs to keep running.

## Building a rule

The popup's Field and Match dropdowns are coupled — you can't build a
combination that doesn't make sense (e.g. "Subject" + "domain" isn't offered,
since a subject line doesn't have a domain).

| Field | Match options | Example |
|---|---|---|
| **From** | contains · equals (exact address) · from domain | `zerodha.com` as a domain rule |
| **Subject** | contains · equals | `"margin call"` |
| **Body preview** | contains · equals | `"price alert"` |

Any rule matching = instant notification, no AI call, no cost.

## AI fallback — for the fuzzy stuff

Rules can't catch "anything related to sales." For that, flip on AI fallback,
describe the category in plain English, and pick a provider:

| Provider | Example model string |
|---|---|
| **Anthropic** | `claude-sonnet-4-6` |
| **OpenAI** | `gpt-4o-mini` |
| **Google Gemini** | `gemini-2.0-flash` |
| **OpenRouter** | `anthropic/claude-3.5-haiku`, `meta-llama/llama-3.1-8b-instruct`, … |

It only ever sends the subject + preview snippet — never the full email body
— and only for mail that *no rule already caught*, so you're not paying for
AI calls on everything.

## Good to know

- **Gmail tab requirement** — see [Requirements](#requirements) above.
- **Sees the current inbox page** (~50 conversations, Gmail's default) —
  not your whole mailbox. New mail always lands at the top of page one, so
  this is a non-issue in practice.
- **Respects Gmail's category tabs.** If you use Primary/Social/Promotions,
  only the tab currently open gets scanned. Turn off Categories in Gmail
  settings for full single-list coverage.
- **First scan is a baseline, not a check** — existing inbox mail never
  triggers a notification flood on install.
- **DOM-based by design.** If Google ever reshuffles Gmail's layout, the
  only thing that might need a touch-up is `extractRow()` in `content.js` —
  everything else is untouched.
- Your AI key lives only in `chrome.storage.local`, sent only to the
  provider you chose.

## Project structure

```
gmail-category-watcher/
├── manifest.json          # Manifest V3 config — permissions, content script registration
├── content.js              # Runs on mail.google.com — reads the inbox DOM
├── background.js           # Service worker — matching, AI fallback, notifications
├── popup.html / .css / .js # The UI you actually click on
├── lib/
│   ├── ruleMatcher.js       # Pure rule-evaluation logic
│   ├── aiClassifier.js      # Anthropic / OpenAI / Gemini / OpenRouter calls
│   ├── notifier.js          # chrome.notifications wrapper
│   └── storage.js           # Single source of truth for the storage schema
└── icons/
```

## License

MIT — do whatever you want with it.
