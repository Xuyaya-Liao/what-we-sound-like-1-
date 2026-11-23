// words.js: cuts a transcript into words, and finds which of them are new
// (step 3 of DESIGN-two-screens.md: the semantic screen's ring of words).
//
// Splitting into words: the browser's Intl.Segmenter does it for any language,
// including those written without spaces (Chinese, Japanese, Thai), using the same
// dictionaries the browser uses to select a word on double-click. Punctuation and
// spaces are left out.
//
// Which words are new: Whisper hears the last 10 seconds every 5 seconds (step 5),
// so the second half of one transcript is usually heard again at the start of the
// next. Those words are already on the ring; only what comes after them is added.

// "湖面很安静" → ["湖面", "很", "安静"]; "The lake is calm." → ["The", "lake", "is", "calm"]
export function splitWords(text, language) {
  let segmenter;
  try {
    segmenter = new Intl.Segmenter(language && language !== "?" ? language : undefined, { granularity: "word" });
  } catch {
    segmenter = new Intl.Segmenter(undefined, { granularity: "word" }); // a language code the browser doesn't know
  }
  return [...segmenter.segment(text)]
    .filter((piece) => piece.isWordLike)
    .map((piece) => piece.segment.replace(/[�\p{Cc}\p{Cf}]/gu, "")) // see transcript.js
    .filter(isRealWord);
}

// A word worth showing: letters and digits only (an apostrophe or hyphen inside is
// fine), and no characters a font can't draw (private-use or unassigned code points,
// which show as boxes or garbage). Anything else is left off the ring (2026-11-21).
function isRealWord(word) {
  if (!/[\p{L}\p{N}]/u.test(word)) return false;
  if (/[\p{Co}\p{Cn}\p{S}]/u.test(word)) return false;
  return /^[\p{L}\p{M}\p{N}'’-]+$/u.test(word);
}

// For comparing: capitals and full-width forms don't count
export const normalizeWord = (word) => word.normalize("NFKC").toLowerCase();

// The ring of words itself, kept by the engine (main.js) and sent whole to the
// semantic screen each round, so a screen opened late gets every word at once.
// It has a fixed number of slots around the circle. New words go into the next
// slots in turn, replacing the oldest, like a hand sweeping round a clock face.
// Each word carries its similarity to every label (the text model compares them in
// the worker, "words"), so the screen can weigh it against whichever label is chosen.
export function createWordRing(slotCount) {
  let slots = new Array(slotCount).fill(null); // { text, scores: [per label] } or null
  let cursor = 0; // the next slot to fill
  let previous = []; // the last transcript's words, to find the repeated ones
  let labels = []; // the label ids the scores are in the order of
  let language = "";

  return {
    // The words of this transcript that aren't already on the ring.
    // typed: a sentence typed in the debug panel, never a repeat of the last one heard
    newWords(text, lang, { typed = false } = {}) {
      const words = splitWords(text, lang);
      const skip = typed ? 0 : repeatedAtStart(previous, words);
      if (!typed) previous = words;
      return words.slice(skip).slice(-slotCount); // a very long sentence keeps its end
    },

    // Puts words (with their score rows) into the next slots. Returns the slots used.
    add(words, scoreRows, labelIds, lang) {
      labels = labelIds;
      if (lang) language = lang;
      return words.map((text, i) => {
        const slot = cursor;
        slots[slot] = { text, scores: scoreRows[i].map((score) => Math.round(score * 1000) / 1000) };
        cursor = (cursor + 1) % slotCount;
        return slot;
      });
    },

    // What is published on the bus: every slot, and which were just filled
    state(added = []) {
      return { labels, language, slots, added };
    },

    reset() {
      slots = new Array(slotCount).fill(null);
      cursor = 0;
      previous = [];
      language = "";
    },
  };
}

// previous: the last transcript's words; words: this one's.
// Returns how many words at the START of this transcript were already heard: the
// longest run at its start that also appears, in the same order, somewhere in the
// previous one (Whisper may end the previous one a little differently, so the run
// doesn't have to be at its very end). A single shared word is too likely to be
// chance ("the", "我"), so at least two must match — unless the whole transcript is
// one word that was heard before.
export function repeatedAtStart(previous, words) {
  const before = previous.map(normalizeWord);
  const now = words.map(normalizeWord);
  for (let length = Math.min(before.length, now.length); length >= 1; length--) {
    if (length < 2 && now.length > 1) break;
    for (let start = before.length - length; start >= 0; start--) {
      let same = true;
      for (let i = 0; i < length && same; i++) same = before[start + i] === now[i];
      if (same) return length;
    }
  }
  return 0;
}
