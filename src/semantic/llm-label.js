// llm-label.js: asks a cloud LLM which label fits what was said (step 6).
//
// The LLM reads the transcript (any language, never translated) and the label table
// (id + description of each label, from config/labels.json). It answers with one id.
// It knows the labels, not the images, and may associate freely: "I like blue" can
// lead to still_water or night_sky, which the local text model can't do.
//
// It goes through OpenRouter (openrouter.ai), one address for many LLMs, as in the
// professor's example. That needs an API key, which costs money per token used, so:
//   · the LLM is off unless switched on (CONFIG.llm.mode, or ?llm=on in the address bar)
//   · the key is never in the code: the page asks for it (debug panel) and keeps it
//     in this browser only (localStorage). The public site will use a relay (step 12).
//   · answers are remembered: the same sentence is never asked twice (also in localStorage)
//   · a sentence already contained in the last one asked (the 10-second window hears
//     things twice) reuses that answer
//
// localStorage: a small store the browser keeps for each website, across visits.

import { CONFIG } from "../config.js";

const KEY_STORAGE = "wwsl.openrouterKey";
const CACHE_STORAGE = "wwsl.llmAnswers";
const CACHE_LIMIT = 500; // remembered answers; the oldest are forgotten first

// Is the LLM switched on? ?llm=on / ?llm=off in the address bar wins over config.js.
export function llmSwitchedOn() {
  const fromAddress = new URLSearchParams(location.search).get("llm");
  return (fromAddress ?? CONFIG.llm.mode) === "on";
}

// ---- The key, kept in this browser only ----
// try / catch: some browsers (private windows) refuse localStorage
export const apiKey = {
  get() {
    try {
      return localStorage.getItem(KEY_STORAGE) ?? "";
    } catch {
      return "";
    }
  },
  set(key) {
    try {
      localStorage.setItem(KEY_STORAGE, key.trim());
    } catch {
      // nothing to do: the key just won't be remembered
    }
  },
  forget() {
    try {
      localStorage.removeItem(KEY_STORAGE);
    } catch {
      // nothing to do
    }
  },
};

// ---- Remembered answers ----
function loadCache() {
  try {
    return new Map(JSON.parse(localStorage.getItem(CACHE_STORAGE) ?? "[]"));
  } catch {
    return new Map();
  }
}

function saveCache(cache) {
  while (cache.size > CACHE_LIMIT) cache.delete(cache.keys().next().value);
  try {
    localStorage.setItem(CACHE_STORAGE, JSON.stringify([...cache]));
  } catch {
    // full or refused: answers are still remembered until the page closes
  }
}

// ---- The prompt ----
// System message: what the LLM is for, and the label table. User message: the
// transcript, exactly as heard.
function systemPrompt(labels) {
  const table = labels.map((label) => `${label.id}: ${label.description}`).join("\n");
  return [
    "You are part of an art installation about the human voice and nature.",
    "A visitor speaks, in any language. You read what they said and choose the ONE category",
    "of nature images that answers it best, literally or by association (colours, moods,",
    "memories, sounds, places). Always choose one, even for small talk.",
    "Reply with the category id only, exactly as written below, and nothing else.",
    "",
    "Categories (id: what the images show):",
    table,
  ].join("\n");
}

// labels: the label table ([{ id, name, description }])
export function createLlmLabeller(labels) {
  const ids = labels.map((label) => label.id);
  const system = systemPrompt(labels);
  const cache = loadCache();
  const usage = { calls: 0, promptTokens: 0, answerTokens: 0, cost: 0 }; // this visit, for the debug panel
  let last; // { text, id }: the last sentence actually asked, and its answer

  // Finds the label id in the LLM's reply (it may add quotes, a full stop, capitals…)
  function findId(reply) {
    const words = reply.toLowerCase().match(/[a-z_]+/g) ?? [];
    return words.find((word) => ids.includes(word));
  }

  async function askOpenRouter(text) {
    const key = apiKey.get();
    if (!key) throw new Error("no API key: paste it in the debug panel");

    // Give up after a few seconds: the local label is already showing
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), CONFIG.llm.timeoutSeconds * 1000);
    try {
      const response = await fetch(CONFIG.llm.url, {
        method: "POST",
        signal: controller.signal,
        headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          model: CONFIG.llm.model,
          max_tokens: CONFIG.llm.maxTokens, // the answer is one id: a few tokens
          temperature: 0, // the same sentence → the same answer
          reasoning: { effort: CONFIG.llm.reasoning }, // no thinking before answering (see config.js)
          messages: [
            { role: "system", content: system },
            { role: "user", content: text },
          ],
        }),
      });
      const reply = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(reply.error?.message ?? `OpenRouter answered ${response.status}`);
      return reply;
    } catch (error) {
      if (error.name === "AbortError") throw new Error(`no answer within ${CONFIG.llm.timeoutSeconds} s`);
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    usage,

    // text → { id, ms, tokens: { prompt, answer }, cost, from: "LLM" | "remembered" | "repeated" }
    async ask(text) {
      const started = performance.now();
      const cacheKey = `${CONFIG.llm.model}\n${text}`;

      if (cache.has(cacheKey)) return { id: cache.get(cacheKey), ms: 0, from: "remembered" };
      if (last && last.text.includes(text)) return { id: last.id, ms: 0, from: "repeated" };

      const reply = await askOpenRouter(text);
      const content = reply.choices?.[0]?.message?.content ?? "";
      const id = findId(content);
      const tokens = { prompt: reply.usage?.prompt_tokens ?? 0, answer: reply.usage?.completion_tokens ?? 0 };
      const cost = reply.usage?.cost ?? 0; // in US dollars, when OpenRouter reports it
      usage.calls += 1;
      usage.promptTokens += tokens.prompt;
      usage.answerTokens += tokens.answer;
      usage.cost += cost;
      if (!id) {
        // An empty reply that hit the token limit: the tokens went into thinking
        const ranOut = reply.choices?.[0]?.finish_reason === "length";
        if (!content && ranOut) throw new Error(`used all ${CONFIG.llm.maxTokens} tokens thinking, no label`);
        if (!content) throw new Error(reply.error?.message ?? "answered nothing");
        throw new Error(`answered “${content.slice(0, 40)}”, which is not a label`);
      }

      const answer = { id, ms: Math.round(performance.now() - started), tokens, cost, from: "LLM" };
      cache.set(cacheKey, id);
      saveCache(cache);
      last = { text, id };
      return answer;
    },
  };
}
