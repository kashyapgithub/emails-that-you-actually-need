/**
 * popup.js
 * --------
 * Everything the popup UI needs: reading/writing settings and rules,
 * triggering interactive sign-in, and telling the background worker when
 * something changed. No Gmail/AI logic lives here — it only talks to
 * storage.js directly (for reads/writes) and to background.js via
 * chrome.runtime.sendMessage (for actions that need the service worker).
 */

import { getSettings, saveSettings, getRules, saveRules, getMatchLog } from "./lib/storage.js";
import { describeRule, isValidRegex } from "./lib/ruleMatcher.js";

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
    row.innerHTML = `<span>${describeRule(rule)}</span>`;
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
      <div class="subject">${entry.subject || "(no subject)"}</div>
      <div class="meta">${entry.from} · ${entry.matchedBy}</div>
      <div class="meta">${time}</div>
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
