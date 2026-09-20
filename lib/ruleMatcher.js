/**
 * ruleMatcher.js
 * --------------
 * Pure logic, no side effects, no network calls — easy to reason about and
 * test in isolation. Given one email and the list of saved rules, decides
 * whether any rule matches (OR logic: ANY matching rule is a hit).
 */

function extractDomain(fromHeader) {
  const emailMatch = fromHeader.match(/[\w.+-]+@([\w-]+\.[\w.-]+)/);
  return emailMatch ? emailMatch[1].toLowerCase() : "";
}

function extractEmailAddress(fromHeader) {
  const emailMatch = fromHeader.match(/[\w.+-]+@[\w-]+\.[\w.-]+/);
  return emailMatch ? emailMatch[0].toLowerCase() : fromHeader.trim().toLowerCase();
}

function normalize(value, caseSensitive) {
  return caseSensitive ? value : value.toLowerCase();
}

function fieldValue(email, field) {
  switch (field) {
    case "from":
      return email.from;
    case "subject":
      return email.subject;
    case "snippet":
      return email.snippet;
    default:
      return "";
  }
}

/** Evaluates a single rule against a single email. */
export function ruleMatches(rule, email) {
  // "domain" only makes semantic sense against the From field — a subject
  // or body snippet has no "domain" to compare. If a stale/malformed rule
  // somehow has field !== "from" with match === "domain", treat it as a
  // non-match rather than silently checking the sender anyway.
  if (rule.match === "domain") {
    if (rule.field !== "from") return false;
    return extractDomain(email.from) === rule.value.trim().toLowerCase();
  }

  // For "equals" on the From field, comparing against the raw header
  // ("John Doe <john@x.com>") would almost never match what a person
  // actually types. Compare against the extracted email address instead.
  if (rule.field === "from" && rule.match === "equals") {
    return extractEmailAddress(email.from) === rule.value.trim().toLowerCase();
  }

  const raw = fieldValue(email, rule.field) || "";
  const haystack = normalize(raw, rule.caseSensitive);
  const needle = normalize(rule.value, rule.caseSensitive);

  if (rule.match === "equals") return haystack.trim() === needle.trim();
  // default: "contains"
  return haystack.includes(needle);
}

/**
 * Returns the first matching rule, or null if none matched.
 * Callers use the return value both as a boolean and to report *why*
 * something matched (shown in the notification/match log).
 */
export function findMatchingRule(rules, email) {
  return rules.find((rule) => ruleMatches(rule, email)) || null;
}
