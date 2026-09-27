/**
 * ruleMatcher.test.js
 * -------------------
 * Covers lib/ruleMatcher.js — deliberately the first thing tested, since
 * it's pure logic with zero chrome.* dependencies (easy to test directly)
 * and it's the piece that decides whether you get notified about
 * something you actually care about. A silent regression here is the
 * worst kind: no error, no crash, just a rule that quietly stops working.
 *
 * Run with: node --test tests/
 * (Node's built-in test runner — no npm install, no dependencies, in
 * keeping with the rest of this project's zero-setup philosophy.)
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  ruleMatches,
  findMatchingRule,
  describeRule,
  isValidRegex,
  caseSensitivityApplies,
  extractDomain,
  extractEmailAddress,
} from "../lib/ruleMatcher.js";

const sampleEmail = (overrides = {}) => ({
  from: "Zerodha Support <support@zerodha.com>",
  subject: "Margin Call: Action Required",
  snippet: "Your account requires additional funds to cover your position.",
  ...overrides,
});

describe("ruleMatches — contains", () => {
  test("matches a substring, case-insensitive by default", () => {
    const rule = { field: "subject", match: "contains", value: "margin call", caseSensitive: false };
    assert.equal(ruleMatches(rule, sampleEmail()), true);
  });

  test("case-sensitive contains rejects a differently-cased match", () => {
    const rule = { field: "subject", match: "contains", value: "MARGIN CALL", caseSensitive: true };
    assert.equal(ruleMatches(rule, sampleEmail()), false);
  });

  test("does not match unrelated text", () => {
    const rule = { field: "subject", match: "contains", value: "invoice", caseSensitive: false };
    assert.equal(ruleMatches(rule, sampleEmail()), false);
  });
});

describe("ruleMatches — domain (the field/match coupling bug fix)", () => {
  test("matches the sender's domain", () => {
    const rule = { field: "from", match: "domain", value: "zerodha.com", caseSensitive: false };
    assert.equal(ruleMatches(rule, sampleEmail()), true);
  });

  test("domain comparison ignores case regardless of the caseSensitive flag", () => {
    const rule = { field: "from", match: "domain", value: "ZERODHA.COM", caseSensitive: true };
    assert.equal(ruleMatches(rule, sampleEmail()), true);
  });

  test(
    "REGRESSION: a domain rule stored with field !== 'from' must fail closed, not silently check the sender anyway",
    () => {
      // This is the exact bug found during the popup UI audit: the Match
      // dropdown used to let you build "Subject" + "from domain", and the
      // matcher used to ignore the field and check the sender's domain
      // regardless — meaning the rule silently did something different
      // from what it visually said. The UI now prevents building this
      // combination, but the matcher itself must also refuse it, in case
      // a stale/imported rule somehow has this shape.
      const malformedRule = { field: "subject", match: "domain", value: "zerodha.com", caseSensitive: false };
      assert.equal(ruleMatches(malformedRule, sampleEmail()), false);
    }
  );

  test("subdomains are matched exactly, not just the root domain", () => {
    const rule = { field: "from", match: "domain", value: "zerodha.com", caseSensitive: false };
    const email = sampleEmail({ from: "Alerts <alerts@mail.zerodha.com>" });
    assert.equal(ruleMatches(rule, email), false, "mail.zerodha.com should not match a bare zerodha.com rule");
  });
});

describe("ruleMatches — equals on From (address extraction)", () => {
  test("matches the extracted address, not the raw header with display name", () => {
    const rule = { field: "from", match: "equals", value: "support@zerodha.com", caseSensitive: false };
    assert.equal(ruleMatches(rule, sampleEmail()), true);
  });

  test("REGRESSION: equals must not require matching the full raw header verbatim", () => {
    // Before this was fixed, "equals" compared against the full raw
    // "From" header ('Zerodha Support <support@zerodha.com>'), which a
    // person typing just the email address would never match.
    const rule = { field: "from", match: "equals", value: "Zerodha Support <support@zerodha.com>", caseSensitive: false };
    // This should NOT match — the point of the fix is that people type the
    // bare address, and the raw header is not what's compared against.
    assert.equal(ruleMatches(rule, sampleEmail()), false);
  });
});

describe("ruleMatches — regex", () => {
  test("alternation catches a deliberately-listed misspelling", () => {
    const rule = { field: "subject", match: "regex", value: "margin\\s*call?", caseSensitive: false };
    const email = sampleEmail({ subject: "URGENT: Margin Cal for your account" }); // "Cal" not "Call"
    assert.equal(ruleMatches(rule, email), true);
  });

  test("an invalid pattern fails closed (no match, no throw) rather than crashing the whole batch", () => {
    const rule = { field: "subject", match: "regex", value: "inv(oice", caseSensitive: false }; // unbalanced paren
    assert.doesNotThrow(() => ruleMatches(rule, sampleEmail()));
    assert.equal(ruleMatches(rule, sampleEmail()), false);
  });

  test("is case-insensitive by default", () => {
    const rule = { field: "subject", match: "regex", value: "MARGIN CALL", caseSensitive: false };
    assert.equal(ruleMatches(rule, sampleEmail()), true);
  });
});

describe("isValidRegex", () => {
  test("accepts a well-formed pattern", () => {
    assert.equal(isValidRegex("inv(oice)?"), true);
  });

  test("rejects a malformed pattern", () => {
    assert.equal(isValidRegex("inv(oice"), false);
  });
});

describe("findMatchingRule", () => {
  test("returns the first matching rule out of several", () => {
    const rules = [
      { field: "subject", match: "contains", value: "invoice", caseSensitive: false },
      { field: "subject", match: "contains", value: "margin call", caseSensitive: false },
    ];
    const result = findMatchingRule(rules, sampleEmail());
    assert.equal(result?.value, "margin call");
  });

  test("returns null when nothing matches", () => {
    const rules = [{ field: "subject", match: "contains", value: "invoice", caseSensitive: false }];
    assert.equal(findMatchingRule(rules, sampleEmail()), null);
  });
});

describe("describeRule", () => {
  test("prefixes critical rules with the warning emoji", () => {
    const rule = { field: "subject", match: "contains", value: "margin call", caseSensitive: false, priority: "critical" };
    assert.match(describeRule(rule), /^🔴/);
  });

  test("does not prefix normal-priority rules", () => {
    const rule = { field: "subject", match: "contains", value: "margin call", caseSensitive: false, priority: "normal" };
    assert.doesNotMatch(describeRule(rule), /^🔴/);
  });

  test("shows the domain form distinctly from a plain contains rule", () => {
    const rule = { field: "from", match: "domain", value: "zerodha.com", caseSensitive: false };
    assert.equal(describeRule(rule), "From domain = zerodha.com");
  });
});

describe("caseSensitivityApplies (the greyed-out-checkbox logic)", () => {
  test("does not apply to domain rules", () => {
    assert.equal(caseSensitivityApplies({ field: "from", match: "domain" }), false);
  });

  test("does not apply to From+equals (address comparison)", () => {
    assert.equal(caseSensitivityApplies({ field: "from", match: "equals" }), false);
  });

  test("applies to Subject+contains", () => {
    assert.equal(caseSensitivityApplies({ field: "subject", match: "contains" }), true);
  });

  test("applies to regex on any field", () => {
    assert.equal(caseSensitivityApplies({ field: "snippet", match: "regex" }), true);
  });
});

describe("extractDomain / extractEmailAddress", () => {
  test("extracts a simple domain", () => {
    assert.equal(extractDomain("Support <support@zerodha.com>"), "zerodha.com");
  });

  test("extracts a subdomain in full, not just the root", () => {
    assert.equal(extractDomain("Alerts <alerts@mail.zerodha.com>"), "mail.zerodha.com");
  });

  test("extracts a multi-part TLD correctly", () => {
    assert.equal(extractDomain("Support <support@zerodha.co.in>"), "zerodha.co.in");
  });

  test("extracts the bare email address from a display-name header", () => {
    assert.equal(extractEmailAddress("Zerodha Support <support@zerodha.com>"), "support@zerodha.com");
  });

  test("falls back to the trimmed lowercase input when no address is found", () => {
    assert.equal(extractEmailAddress("Not An Email"), "not an email");
  });
});
