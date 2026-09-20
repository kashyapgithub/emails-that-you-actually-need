/**
 * popup.js
 * --------
 * Everything the popup UI needs: reading/writing settings and rules,
 * triggering interactive sign-in, and telling the background worker when
 * something changed. No Gmail/AI logic lives here — it only talks to
 * storage.js directly (for reads/writes) and to background.js via
 * chrome.runtime.sendMessage (for actions that need the service worker).
 */

import { getSettings, saveSettings, getRules, saveRules, getMatchLog, clearMatchLog, resetUnseenCount } from "./lib/storage.js";
import { describeRule, isValidRegex, ruleMatches } from "./lib/ruleMatcher.js";
import { updateBadge } from "./lib/notifier.js";

const el = (id) => document.getElementById(id);

function uid() {
  return Math.random().toString(36).slice(2, 10);
}

// Sensible starting model for each provider, so switching providers doesn't
// leave a stale/incompatible model name sitting in the field. The user can
// still type over these with anything their account has access to.
const DEFAULT_MODEL_BY_PROVIDER = {
  anthropic: "claude-sonnet-4-6",
  openai: "gpt-4o-mini",
  gemini: "gemini-2.0-flash",
  openrouter: "openai/gpt-4o-mini",
  xai: "grok-4",
};

// The available "Match" options depend entirely on which Field is selected —
// "domain" only makes sense for From, so it's simply not offered for
// Subject/Body. This makes the earlier nonsensical combo (e.g. "Subject" +
// "from domain") impossible to construct in the UI at all.
const MATCH_OPTIONS_BY_FIELD = {
  from: [
    ["contains", "contains"],
    ["equals", "equals (exact sender address)"],
    ["domain", "from domain"],
    ["regex", "matches pattern (regex)"],
  ],
  subject: [
    ["contains", "contains"],
    ["equals", "equals (exact match)"],
    ["regex", "matches pattern (regex)"],
  ],
  snippet: [
    ["contains", "contains"],
    ["equals", "equals (exact match)"],
    ["regex", "matches pattern (regex)"],
  ],
};

const VALUE_PLACEHOLDER_BY_FIELD_AND_MATCH = {
  "from:regex": "e.g. (zerodha|zerodh4|kite)\\.com",
  "subject:regex": "e.g. margin\\s*call|forced\\s*liquidation",
  "snippet:regex": "e.g. price\\s*alert",
};

const VALUE_PLACEHOLDER_BY_FIELD = {
  from: "e.g. alerts@broker.com or brokername.com",
  subject: "e.g. margin call",
  snippet: "e.g. price alert",
};

function refreshMatchOptions() {
  const field = el("ruleField").value;
  const matchSelect = el("ruleMatch");
  const previousValue = matchSelect.value;
  const options = MATCH_OPTIONS_BY_FIELD[field] || MATCH_OPTIONS_BY_FIELD.subject;

  matchSelect.innerHTML = "";
  options.forEach(([value, label]) => {
    const opt = document.createElement("option");
    opt.value = value;
    opt.textContent = label;
    matchSelect.appendChild(opt);
  });
  // Keep the previous choice selected if it's still valid for the new field
  // (e.g. switching From -> Subject while on "contains" stays on "contains");
  // otherwise fall back to the first option rather than an invalid one.
  if (options.some(([value]) => value === previousValue)) {
    matchSelect.value = previousValue;
  }

  refreshValuePlaceholder();
}

function refreshValuePlaceholder() {
  const field = el("ruleField").value;
  const match = el("ruleMatch").value;
  const regexKey = `${field}:regex`;
  el("ruleValue").placeholder =
    match === "regex"
      ? VALUE_PLACEHOLDER_BY_FIELD_AND_MATCH[regexKey]
      : VALUE_PLACEHOLDER_BY_FIELD[field] || "";
}

// Fields that are meaningless while AI fallback is switched off — greyed out
// so it's visually obvious they're inactive, instead of letting someone fill
// in an API key and description that quietly do nothing until they notice
// the checkbox above them.
const AI_DEPENDENT_FIELD_IDS = ["categoryDescription", "aiProvider", "aiModel", "aiApiKey"];

function refreshAiFieldState() {
  const enabled = el("aiEnabled").checked;
  AI_DEPENDENT_FIELD_IDS.forEach((id) => {
    el(id).disabled = !enabled;
  });
}

function refreshCheckNowAvailability(isRunning) {
  const btn = el("checkNowBtn");
  btn.disabled = !isRunning;
  btn.title = isRunning ? "" : "Turn on watching (top-right toggle) first";
}

function renderRules(rules) {
  const container = el("ruleList");
  container.innerHTML = "";
  if (rules.length === 0) {
    container.innerHTML = '<p class="hint">No rules yet — add one below.</p>';
    return;
  }
  rules.forEach((rule) => {
    const row = document.createElement("div");
    row.className = "rule-item";
    row.innerHTML = `<span>${escapeHtml(describeRule(rule))}</span>`;
    const removeBtn = document.createElement("button");
    removeBtn.textContent = "Remove";
    removeBtn.className = "secondary";
    removeBtn.onclick = async () => {
      const updated = rules.filter((r) => r.id !== rule.id);
      await saveRules(updated);
      renderRules(updated);
    };
    row.appendChild(removeBtn);
    container.appendChild(row);
  });
}

/**
 * Escapes a string for safe insertion into innerHTML. MUST be used for any
 * value that came from email content (subject, sender, snippet) — that
 * text is written by whoever sent the email, not by you, so it's untrusted
 * input the same way a comment on a public form would be. Without this,
 * a crafted subject line could inject markup into this extension's own
 * popup page.
 */
function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str ?? "";
  return div.innerHTML;
}

function renderMatchLog(log) {
  const container = el("matchLog");
  container.innerHTML = "";
  if (log.length === 0) {
    container.innerHTML = '<p class="hint">No matches yet.</p>';
    return;
  }
  log.forEach((entry) => {
    const div = document.createElement("div");
    div.className = "match-item";
    const time = new Date(entry.timestamp).toLocaleString();
    div.innerHTML = `
      <div class="subject">${escapeHtml(entry.subject) || "(no subject)"}</div>
      <div class="meta">${escapeHtml(entry.from)} · ${escapeHtml(entry.matchedBy)}</div>
      <div class="meta">${escapeHtml(time)}</div>
    `;
    container.appendChild(div);
  });
}

async function refreshTabStatus() {
  const { tabCount } = await chrome.runtime.sendMessage({ type: "GET_TAB_COUNT" });
  const status = el("tabStatus");
  if (tabCount > 0) {
    status.textContent = `Watching ${tabCount} open Gmail tab${tabCount > 1 ? "s" : ""}.`;
  } else {
    status.textContent = "No Gmail tab open — one will open automatically once you turn watching on.";
  }
}

// ---- Wiring up controls ---------------------------------------------------

async function init() {
  const settings = await getSettings();
  const rules = await getRules();
  const log = await getMatchLog();

  el("runningToggle").checked = settings.isRunning;
  el("aiEnabled").checked = settings.aiFallbackEnabled;
  el("categoryDescription").value = settings.categoryDescription;
  el("aiProvider").value = settings.aiProvider;
  el("aiModel").value = settings.aiModel;
  el("aiApiKey").value = settings.aiApiKey;
  el("pollInterval").value = String(settings.pollIntervalMinutes);

  renderRules(rules);
  renderMatchLog(log);
  refreshTabStatus();
  refreshMatchOptions(); // populate Match dropdown correctly for the default Field on load
  refreshAiFieldState();
  refreshCheckNowAvailability(settings.isRunning);

  // Opening the popup IS the acknowledgment — clear the "you have unseen
  // matches" badge the same way opening a notifications tray would.
  await resetUnseenCount();
  await updateBadge(0);

  el("ruleField").addEventListener("change", refreshMatchOptions);
  el("ruleMatch").addEventListener("change", refreshValuePlaceholder);
  el("aiEnabled").addEventListener("change", refreshAiFieldState);

  el("openGmailBtn").onclick = async () => {
    await chrome.tabs.create({ url: "https://mail.google.com/mail/u/0/#inbox", pinned: true, active: true });
    setTimeout(refreshTabStatus, 1500);
  };

  el("runningToggle").onchange = async (e) => {
    await chrome.runtime.sendMessage({ type: "SET_RUNNING", value: e.target.checked });
    refreshCheckNowAvailability(e.target.checked);
    setTimeout(refreshTabStatus, 1500);
  };

  el("addRuleBtn").onclick = async () => {
    const value = el("ruleValue").value.trim();
    el("ruleError").textContent = "";
    if (!value) return;
    const field = el("ruleField").value;
    const match = el("ruleMatch").value;

    if (match === "regex" && !isValidRegex(value)) {
      el("ruleError").textContent = "That's not a valid regular expression — check the brackets/escaping.";
      return;
    }

    const existingRules = await getRules();
    // Skip adding an identical rule twice (e.g. an accidental double-click) —
    // it would work fine but just clutters the list with a duplicate.
    const alreadyExists = existingRules.some(
      (r) => r.field === field && r.match === match && r.value.toLowerCase() === value.toLowerCase()
    );
    if (alreadyExists) {
      el("ruleValue").value = "";
      return;
    }

    const newRule = { id: uid(), field, match, value, caseSensitive: false };
    const updated = [...existingRules, newRule];
    await saveRules(updated);
    renderRules(updated);
    el("ruleValue").value = "";
  };

  // Tests a DRAFT rule (not yet saved) against whatever's actually visible
  // in your Gmail tab right now — so you can confirm a regex or keyword
  // actually catches what you think it does before committing to it,
  // instead of waiting for real mail to arrive to find out it doesn't.
  // Deliberately read-only: it never marks anything as seen or fires a
  // real notification (see GET_CURRENT_INBOX_ROWS in background.js).
  el("previewRuleBtn").onclick = async () => {
    const value = el("ruleValue").value.trim();
    const errorEl = el("ruleError");
    errorEl.style.color = "";
    errorEl.textContent = "";

    if (!value) {
      errorEl.textContent = "Enter a value first.";
      return;
    }
    const field = el("ruleField").value;
    const match = el("ruleMatch").value;
    if (match === "regex" && !isValidRegex(value)) {
      errorEl.textContent = "That's not a valid regular expression — check the brackets/escaping.";
      return;
    }

    el("previewRuleBtn").disabled = true;
    el("previewRuleBtn").textContent = "Checking…";
    const { rows, tabCount } = await chrome.runtime.sendMessage({ type: "GET_CURRENT_INBOX_ROWS" });
    el("previewRuleBtn").disabled = false;
    el("previewRuleBtn").textContent = "Preview matches";

    if (tabCount === 0) {
      errorEl.textContent = "No Gmail tab open to preview against — open one first.";
      return;
    }

    const draftRule = { field, match, value, caseSensitive: false };
    const matchCount = rows.filter((row) => ruleMatches(draftRule, row)).length;
    errorEl.style.color = matchCount > 0 ? "#2e7d32" : "#5f6368";
    errorEl.textContent =
      matchCount > 0
        ? `✓ Would match ${matchCount} of ${rows.length} currently visible emails.`
        : `No matches among the ${rows.length} currently visible emails — check your pattern.`;
  };

  // Rules only ever live in this one browser's local storage — no sync
  // across machines, and they're gone if you ever uninstall. Export/import
  // is the manual backup/transfer mechanism for that gap.
  el("exportRulesBtn").onclick = async () => {
    const rules = await getRules();
    const blob = new Blob([JSON.stringify(rules, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "gmail-category-watcher-rules.json";
    a.click();
    URL.revokeObjectURL(url);
  };

  el("importRulesBtn").onclick = () => el("importRulesFile").click();

  el("importRulesFile").onchange = async (e) => {
    const file = e.target.files[0];
    const errorEl = el("ruleError");
    errorEl.style.color = "";
    if (!file) return;

    try {
      const text = await file.text();
      const imported = JSON.parse(text);
      if (!Array.isArray(imported)) throw new Error("not an array");

      const existingRules = await getRules();
      const merged = [...existingRules];
      let added = 0;

      for (const candidate of imported) {
        // Validate each entry independently — one malformed rule in an
        // imported file shouldn't reject the whole import, just get skipped.
        if (
          !candidate ||
          typeof candidate.field !== "string" ||
          typeof candidate.match !== "string" ||
          typeof candidate.value !== "string"
        ) {
          continue;
        }
        if (candidate.match === "regex" && !isValidRegex(candidate.value)) continue;

        const isDuplicate = merged.some(
          (r) =>
            r.field === candidate.field &&
            r.match === candidate.match &&
            r.value.toLowerCase() === candidate.value.toLowerCase()
        );
        if (isDuplicate) continue;

        merged.push({
          id: uid(),
          field: candidate.field,
          match: candidate.match,
          value: candidate.value,
          caseSensitive: !!candidate.caseSensitive,
        });
        added++;
      }

      await saveRules(merged);
      renderRules(merged);
      errorEl.style.color = added > 0 ? "#2e7d32" : "#5f6368";
      errorEl.textContent =
        added > 0 ? `✓ Imported ${added} new rule${added > 1 ? "s" : ""}.` : "No new rules found in that file.";
    } catch {
      errorEl.style.color = "";
      errorEl.textContent = "Couldn't read that file — make sure it's a JSON export from this extension.";
    } finally {
      e.target.value = ""; // allow re-importing the same file later
    }
  };

  el("clearLogBtn").onclick = async () => {
    await clearMatchLog();
    renderMatchLog([]);
  };

  // Save-on-change for every AI/settings field, so nothing needs an explicit "Save" button.
  const persistSettings = async () => {
    await saveSettings({
      aiFallbackEnabled: el("aiEnabled").checked,
      categoryDescription: el("categoryDescription").value,
      aiProvider: el("aiProvider").value,
      aiModel: el("aiModel").value,
      aiApiKey: el("aiApiKey").value,
      pollIntervalMinutes: Number(el("pollInterval").value),
    });
  };

  ["aiEnabled", "categoryDescription", "aiProvider", "aiModel", "aiApiKey"].forEach((id) => {
    el(id).addEventListener("change", persistSettings);
  });

  // Auto-fill a working default model whenever the provider changes,
  // rather than leaving e.g. "claude-sonnet-4-6" selected under OpenRouter.
  el("aiProvider").addEventListener("change", async () => {
    el("aiModel").value = DEFAULT_MODEL_BY_PROVIDER[el("aiProvider").value] || "";
    await persistSettings();
  });

  el("pollInterval").addEventListener("change", async () => {
    await persistSettings();
    await chrome.runtime.sendMessage({ type: "SYNC_ALARM" });
  });

  el("checkNowBtn").onclick = async () => {
    el("checkNowBtn").disabled = true;
    el("checkNowBtn").textContent = "Checking…";

    // This now genuinely waits for the full pass — scan, rule matching, and
    // any AI fallback calls — to finish in the background worker, instead
    // of guessing with a fixed timeout that could resolve before the real
    // work (especially a network round-trip to an AI provider) was done.
    const result = await chrome.runtime.sendMessage({ type: "CHECK_NOW" });

    el("checkNowBtn").textContent = "Check now";
    el("checkNowBtn").disabled = false;

    if (result?.ok === false && result.reason === "not_running") {
      el("checkNowBtn").disabled = true; // stays disabled until watching is turned back on
      return;
    }

    renderMatchLog(await getMatchLog());
    refreshTabStatus();
  };
}

init();
