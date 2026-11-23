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
  // "�" (U+FFFD) is what's left when Whisper's last token ends halfway through a
  // Chinese character's bytes; invisible control and formatting characters come
  // through too. Both showed as garbled marks on the semantic screen (2026-11-20).
  const tidy = text.replace(/[�\p{Cc}\p{Cf}]/gu, "").replace(/\s+/g, " ").trim();
  if (!bare(tidy)) return ""; // only punctuation, or nothing
  if (IGNORED.has(bare(tidy))) return ""; // a known hallucination
  // Mostly not letters (symbols, music notes, characters no font can draw): what
  // Whisper writes when it heard nothing it could understand. Shown as nothing.
  const characters = [...tidy.replace(/\s/g, "")];
  const letters = characters.filter((c) => /[\p{L}\p{N}]/u.test(c) && !/[\p{Co}\p{Cn}]/u.test(c)).length;
  if (letters < characters.length * 0.6) return "";
  // Text decoded the wrong way round ("Ã©tÃ©" for "été", "æ¹–" for "湖"): pairs like
  // "Ã" or "æ" followed by a character from the U+0080–U+00BF range never occur in
  // real writing.
  if (/[ÂÃâãäåæçèé][\u0080-¿]/u.test(tidy)) return "";
  // The same word four or more times in a row ("Commission Commission Commission…")
  // is Whisper stuck in a loop, not speech.
  if (/(\b\S+\b)(\s+\1){3,}/iu.test(tidy)) return "";
  return tidy;
}
