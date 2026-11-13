// round-log.js: keeps a record of every round, for experiments (step 9).
//
// Every round (and every typed sentence) becomes one row: what was heard, which sound
// and which label and image were chosen, the scores, and how long each part took.
// The rows can be downloaded as JSON (everything, plus the settings used) or as CSV
// (opens in Excel or Google Sheets, one row per round).
//
// For a reading experiment (the same text read in different ways: whispered, shouted,
// sung…), type a tag in the debug panel before each reading. Every row after that
// carries the tag, so the readings can be compared in the spreadsheet.
//
// The log lives in memory only: reloading the page empties it. Download it first.

const MAX_ROWS = 5000; // about 7 hours of rounds; the oldest are dropped after that

// The CSV columns, in order. (JSON has these too, plus anything else recorded.)
const COLUMNS = [
  "time", "input", "tag", "round", "startSec", "levelDb", "quiet",
  "sound", "soundCategory", "soundScore", "soundCandidates", "clapMs",
  "transcript", "language", "heardSeconds", "whisperMs", "ignored",
  "localLabel", "localTop3", "llmLabel", "llmFrom", "llmMs", "llmTokens",
  "label", "image", "imageTitle", "mismatch",
  "soundSeconds", "imageSeconds", "notes",
];

export function createRoundLog() {
  let rows = [];
  let tag = "";

  return {
    get count() {
      return rows.length;
    },

    get tag() {
      return tag;
    },

    // The tag for the rows that follow ("" for none)
    setTag(text) {
      tag = text.trim();
    },

    clear() {
      rows = [];
    },

    // Starts a new row and returns a handle that works exactly like the debug panel's
    // round handle (handle = what debug.addRound returns). Every result passed to it
    // is shown in the panel AND written into the row.
    // start: what is known when the round begins ({ input, round, startSec, levelDb, quiet })
    track(handle, start) {
      const row = { time: new Date().toISOString(), tag, ...start };
      rows.push(row);
      if (rows.length > MAX_ROWS) rows.shift();

      return {
        took(path, ms) {
          row[`${path}Seconds`] = round2(ms / 1000);
          handle.took(path, ms);
        },
        note(text, part) {
          row.notes = row.notes ? `${row.notes}; ${text}` : text;
          handle.note(text, part);
        },
        sound(result) {
          const { candidates, chosen, ms } = result;
          row.sound = chosen.sound.title;
          row.soundCategory = chosen.sound.category;
          row.soundScore = round3(chosen.score);
          row.soundCandidates = candidates
            .slice(0, 3)
            .map((candidate) => `${candidate.sound.category}: ${candidate.sound.title} ${round3(candidate.score)}`)
            .join(" | ");
          row.clapMs = ms;
          handle.sound(result);
        },
        speech(result) {
          const { text, language, seconds, ms, ignored } = result;
          row.transcript = text ?? "";
          if (language) row.language = language;
          if (seconds) row.heardSeconds = round2(seconds);
          if (ms) row.whisperMs = ms;
          if (ignored) row.ignored = ignored;
          handle.speech(result);
        },
        label(result) {
          const { ranking } = result;
          row.localLabel = ranking[0].id;
          row.localTop3 = ranking.slice(0, 3).map((entry) => `${entry.id} ${round3(entry.score)}`).join(" | ");
          handle.label(result);
        },
        llm(answer) {
          row.llmLabel = answer.id;
          row.llmFrom = answer.from; // "LLM", "remembered" or "repeated"
          row.llmMs = answer.ms;
          if (answer.tokens) row.llmTokens = answer.tokens.prompt + answer.tokens.answer;
          handle.llm(answer);
        },
        image(choice) {
          row.label = choice.image.label; // the label that was finally used
          row.image = choice.image.id;
          row.imageTitle = choice.image.title;
          if (Number.isFinite(choice.mismatch)) row.mismatch = round3(choice.mismatch); // step 10
          handle.image(choice);
        },
      };
    },

    // Everything as JSON, with the settings it was recorded under
    toJson(settings) {
      return JSON.stringify({ exportedAt: new Date().toISOString(), settings, rows }, null, 2);
    },

    // One line per row; text with commas, quotes or line breaks is put in quotes.
    // The "﻿" at the start tells Excel the file is UTF-8, so Chinese text shows correctly.
    toCsv() {
      const cell = (value) => {
        if (value === undefined || value === null) return "";
        const text = String(value);
        return /[",\n\r]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
      };
      const lines = [COLUMNS.join(","), ...rows.map((row) => COLUMNS.map((column) => cell(row[column])).join(","))];
      return "﻿" + lines.join("\r\n");
    },
  };
}

const round2 = (value) => Math.round(value * 100) / 100;
const round3 = (value) => Math.round(value * 1000) / 1000;

// Lets the browser save a text as a file (the usual download bar appears)
export function downloadText(text, fileName, type) {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const link = document.createElement("a");
  link.href = url;
  link.download = fileName;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
