// transcript.js: tidies Whisper's text, and throws away what nobody actually said.
//
// Whisper was trained on huge amounts of subtitled video. Given noise or near-silence,
// it often "hears" phrases that were common there: "you", "Thank you for watching",
// "字幕由Amara.org社区提供" (subtitles by the Amara.org community)… These are known as
// hallucinations. Quiet rounds are already skipped, so this only catches what's left.

import { CONFIG } from "../config.js";

// Lowercase, without punctuation or spaces, for comparing with the list in config.js
function bare(text) {
  return text.toLowerCase().replace(/[\p{P}\p{S}\s]+/gu, "");
}

const IGNORED = new Set(CONFIG.speechIgnore.map(bare));

// Returns the cleaned-up text, or "" if there is nothing real in it.
export function cleanTranscript(text) {
  const tidy = text.replace(/\s+/g, " ").trim();
  if (!bare(tidy)) return ""; // only punctuation, or nothing
  if (IGNORED.has(bare(tidy))) return ""; // a known hallucination
  // The same word four or more times in a row ("Commission Commission Commission…")
  // is Whisper stuck in a loop, not speech.
  if (/(\b\S+\b)(\s+\1){3,}/iu.test(tidy)) return "";
  return tidy;
}
