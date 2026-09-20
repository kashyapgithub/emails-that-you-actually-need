/**
 * aiClassifier.js
 * ---------------
 * Fallback path: only called when NO keyword/sender rule matched an email
 * but AI fallback is enabled. Sends just the subject + snippet (never the
 * full body) to the user's chosen LLM provider and asks for a strict
 * yes/no classification against the category description the user wrote.
 *
 * The user supplies their own API key (stored locally, never leaves the
 * browser except in this one request to the provider they picked).
 */

const SYSTEM_PROMPT =
  "You classify emails into a single category. Reply with ONLY the word " +
  "YES or NO — nothing else, no punctuation, no explanation.";

function buildUserPrompt(categoryDescription, email) {
  return (
    `Category to detect: "${categoryDescription}"\n\n` +
    `Email subject: ${email.subject}\n` +
    `Email from: ${email.from}\n` +
    `Email preview: ${email.snippet}\n\n` +
    `Does this email belong to the category above? Reply YES or NO only.`
  );
}

async function classifyWithAnthropic(apiKey, model, prompt) {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
      // Required for calling the API directly from a browser/extension context.
      "anthropic-dangerous-direct-browser-access": "true",
    },
    body: JSON.stringify({
      model,
      max_tokens: 5,
      system: SYSTEM_PROMPT,
      messages: [{ role: "user", content: prompt }],
    }),
  });
  if (!res.ok) throw new Error(`Anthropic API error ${res.status}: ${await res.text()}`);
  const data = await res.json();
  const text = data.content?.[0]?.text || "";
  return text.trim().toUpperCase().startsWith("YES");
}

/** OpenAI's chat completions endpoint. */
async function classifyWithOpenAI(apiKey, model, prompt) {
  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      max_tokens: 5,
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: prompt },
      ],
    }),
  });
  if (!res.ok) throw new Error(`OpenAI API error ${res.status}: ${await res.text()}`);
  const data = await res.json();
  const text = data.choices?.[0]?.message?.content || "";
  return text.trim().toUpperCase().startsWith("YES");
}

/**
 * OpenRouter is OpenAI-compatible (same request/response shape), just a
 * different base URL, bearer-token header, and it wants the model name
 * prefixed with the provider — e.g. "openai/gpt-4o-mini" or
 * "anthropic/claude-3.5-haiku". OpenRouter also asks for an HTTP-Referer /
 * X-Title header for attribution, which is optional but polite to send.
 */
async function classifyWithOpenRouter(apiKey, model, prompt) {
  const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
      "X-Title": "Gmail Category Watcher",
    },
    body: JSON.stringify({
      model,
      max_tokens: 5,
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: prompt },
      ],
    }),
  });
  if (!res.ok) throw new Error(`OpenRouter API error ${res.status}: ${await res.text()}`);
  const data = await res.json();
  const text = data.choices?.[0]?.message?.content || "";
  return text.trim().toUpperCase().startsWith("YES");
}

/**
 * Google's Gemini has a different request shape (no separate "system role"
 * message array like the others — system instruction is its own field, and
 * content goes in a "parts" array). The API key goes in the URL as a query
 * param rather than a header.
 */
async function classifyWithGemini(apiKey, model, prompt) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      system_instruction: { parts: [{ text: SYSTEM_PROMPT }] },
      contents: [{ role: "user", parts: [{ text: prompt }] }],
      generationConfig: { maxOutputTokens: 5 },
    }),
  });
  if (!res.ok) throw new Error(`Gemini API error ${res.status}: ${await res.text()}`);
  const data = await res.json();
  const text = data.candidates?.[0]?.content?.parts?.[0]?.text || "";
  return text.trim().toUpperCase().startsWith("YES");
}

/**
 * xAI's Grok API is OpenAI-compatible (same request/response shape as
 * OpenAI's chat completions) — just a different base URL. No provider
 * prefix on the model name needed, unlike OpenRouter.
 */
async function classifyWithXai(apiKey, model, prompt) {
  const res = await fetch("https://api.x.ai/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      max_tokens: 5,
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: prompt },
      ],
    }),
  });
  if (!res.ok) throw new Error(`xAI API error ${res.status}: ${await res.text()}`);
  const data = await res.json();
  const text = data.choices?.[0]?.message?.content || "";
  return text.trim().toUpperCase().startsWith("YES");
}

const PROVIDERS = {
  anthropic: (key, model, prompt) => classifyWithAnthropic(key, model, prompt),
  openai: (key, model, prompt) => classifyWithOpenAI(key, model, prompt),
  gemini: (key, model, prompt) => classifyWithGemini(key, model, prompt),
  openrouter: (key, model, prompt) => classifyWithOpenRouter(key, model, prompt),
  xai: (key, model, prompt) => classifyWithXai(key, model, prompt),
};

/**
 * Returns true/false for whether the email matches the category.
 * Any error (bad key, network issue, etc.) is swallowed to `false` so a
 * single AI hiccup never crashes the whole polling cycle — it just means
 * that one email falls back to "no match" for this round.
 */
export async function classifyEmail(settings, email) {
  const prompt = buildUserPrompt(settings.categoryDescription, email);
  const callProvider = PROVIDERS[settings.aiProvider] || PROVIDERS.anthropic;
  try {
    return await callProvider(settings.aiApiKey, settings.aiModel, prompt);
  } catch (err) {
    console.error("[Gmail Category Watcher] AI classification failed:", err);
    return false;
  }
}
