// debug-panel.js: a small panel in the corner that shows what the program is doing.
// Press D to show or hide it.
//
// Top: the input, model status, what is playing, the session summary (step 8), a live level meter.
// Below: one block per 5-second round, newest first. A block is added as soon as
// the segment is cut, and results are filled in as they arrive:
//   #3  10.0 s · -21 dB · voice · prep 3 ms · sound 0.4 s · image 1.8 s   ▶
//       ♪ sound  (step 4)
//       “what was said” · language · seconds heard · Whisper time  (step 5)
//       → closest labels, from the local text model  (step 5)
//       ⇒ the LLM's choice, which replaces it, when the LLM is on  (step 6)
//       ▣ the image shown for the label  (step 7)
// There is also a box for typing a sentence instead of saying it.

import { CONFIG } from "../config.js";

const METER_FLOOR_DB = -70; // the left end of the level meter
const MAX_ROUNDS = 8; // older rounds are removed from the panel

// Converts a dB value to a 0–100% meter position
function meterPercent(db) {
  return Math.max(0, Math.min(100, (100 * (db - METER_FLOOR_DB)) / -METER_FLOOR_DB));
}

function make(tag, text, className) {
  const element = document.createElement(tag);
  if (text !== undefined) element.textContent = text;
  if (className) element.className = className;
  return element;
}

export function createDebugPanel() {
  // ---- Build the panel ----
  const panel = make("aside", undefined, "debug");
  panel.hidden = true;
  panel.append(make("p", "Debug · press D to hide", "debug-title"));

  const input = make("p", "", "debug-line");
  const microphoneRow = make("label", "Microphone ", "debug-line");
  const microphoneSelect = make("select");
  microphoneRow.append(microphoneSelect);
  microphoneRow.hidden = true;
  const warning = make("p", "", "debug-warning");
  warning.hidden = true;
  const models = make("p", "", "debug-line muted");
  const nowPlaying = make("p", "♪ nothing playing yet", "debug-line");
  const stats = make("p", "", "debug-line muted"); // how the piece is keeping up (step 8)
  const typing = make("input", undefined, "debug-typing");
  typing.placeholder = "Type a sentence to test the meaning path, then Enter";
  typing.disabled = true; // until the models are ready
  let onTyped;
  typing.addEventListener("keydown", (event) => {
    event.stopPropagation(); // so typing "d" doesn't hide the panel
    if (event.key === "Enter" && typing.value.trim() && onTyped) {
      onTyped(typing.value.trim());
      typing.value = "";
    }
  });

  // The LLM (step 6): whether it is on, what it has used, and the box for the API key
  const llmLine = make("p", "", "debug-line muted");
  const keyRow = make("div", undefined, "debug-line");
  keyRow.hidden = true;

  const meter = make("div", undefined, "meter");
  const meterFill = make("div", undefined, "meter-fill");
  const threshold = make("div", undefined, "meter-threshold");
  threshold.style.left = `${meterPercent(CONFIG.quietBelowDb)}%`;
  threshold.title = `Quiet below ${CONFIG.quietBelowDb} dB (config.js)`;
  meter.append(meterFill, threshold);

  const rounds = make("div", undefined, "rounds");

  panel.append(input, microphoneRow, warning, models, llmLine, keyRow, nowPlaying, stats, typing, meter, rounds);
  document.body.append(panel);

  // D toggles the panel
  document.addEventListener("keydown", (event) => {
    if (event.key === "d" || event.key === "D") panel.hidden = !panel.hidden;
  });

  // ---- What other code can call ----
  return {
    show() {
      panel.hidden = false;
    },

    setInput(label, sampleRate) {
      input.textContent =
        `${label} · ${sampleRate} Hz → ${CONFIG.soundSampleRate} (CLAP) / ${CONFIG.speechSampleRate} (Whisper)`;
    },

    // Fills the microphone dropdown. onChoose(deviceId) is called when another one is picked.
    // Pass an empty list to hide it (e.g. when a recording is playing).
    setMicrophones(devices, currentId, onChoose) {
      microphoneRow.hidden = devices.length === 0;
      microphoneSelect.replaceChildren(
        ...devices.map((device, index) => new Option(device.label || `Microphone ${index + 1}`, device.deviceId)),
      );
      microphoneSelect.value = currentId;
      microphoneSelect.onchange = () => onChoose(microphoneSelect.value);
    },

    // Shows a problem in orange at the top of the panel; pass "" to clear it.
    setWarning(text) {
      warning.textContent = text;
      warning.hidden = !text;
    },

    setModels(text) {
      models.textContent = text;
    },

    setNowPlaying(sound) {
      nowPlaying.textContent = sound ? `♪ latest: ${sound.title} · ${sound.category}` : "♪ nothing playing";
    },

    // The session summary: rounds, how long the paths take, skips, memory (step 8)
    setStats(text) {
      stats.textContent = text;
    },

    setLevel(db) {
      meterFill.style.width = `${meterPercent(db)}%`;
      meterFill.classList.toggle("loud", db >= CONFIG.quietBelowDb);
    },

    // The LLM line and the key box.
    // on: is the LLM switched on; model: its name; hasKey: is a key saved in this browser;
    // onKey(key): a key was pasted; onForget(): "Forget key" was clicked
    setLlm({ on, model, hasKey, onKey, onForget }) {
      if (!on) {
        llmLine.textContent = "LLM off: labels come from the local text model (add ?llm=on to the address to test the LLM)";
        keyRow.hidden = true;
        return;
      }
      llmLine.textContent = `LLM on · ${model} · no questions yet`;
      keyRow.hidden = false;
      if (hasKey) {
        const forget = make("button", "Forget key");
        forget.onclick = onForget;
        keyRow.replaceChildren(make("span", "OpenRouter key saved in this browser ", "muted"), forget);
      } else {
        const box = make("input", undefined, "debug-typing");
        box.type = "password"; // shown as dots
        box.placeholder = "Paste your OpenRouter key, then Enter (kept in this browser only)";
        box.addEventListener("keydown", (event) => {
          event.stopPropagation(); // so typing "d" doesn't hide the panel
          if (event.key === "Enter" && box.value.trim()) onKey(box.value.trim());
        });
        keyRow.replaceChildren(box);
      }
    },

    // What the LLM has used during this visit
    setLlmUsage({ calls, promptTokens, answerTokens, cost }, model) {
      const money = cost ? ` · $${cost.toFixed(4)}` : "";
      llmLine.textContent =
        `LLM on · ${model} · ${calls} question${calls === 1 ? "" : "s"} · ` +
        `${(promptTokens + answerTokens).toLocaleString("en")} tokens${money} this visit`;
    },

    // Turns on the typing box; onTyped(text) is called when Enter is pressed
    enableTyping(callback) {
      onTyped = callback;
      typing.disabled = false;
    },

    // round: { index, startSec, levelDb, quiet, prepMs, onPlay }
    // Returns a handle for filling in this round's results later.
    addRound(round) {
      const head = make("div", undefined, "round-head");
      const level = Number.isFinite(round.levelDb) ? round.levelDb.toFixed(0) : "-∞";
      head.append(
        make("b", `#${round.index + 1}`),
        ` ${round.startSec.toFixed(1)} s · ${level} dB · ${round.quiet ? "quiet" : "voice"} · prep ${round.prepMs} ms `,
      );
      const play = make("button", "▶");
      play.title = "Play this segment (48 kHz version)";
      play.onclick = round.onPlay;
      head.append(play);
      return addBlock(head, round.quiet);
    },

    // A typed sentence gets a block of its own, with the same handle as a round
    addTyped(text) {
      const handle = addBlock(make("div", "typed ", "round-head"));
      handle.speech({ text, typed: true });
      return handle;
    },
  };

  // One block in the list. The sound and speech paths finish in either order, so
  // each has its own place in the block and their lines never get mixed up.
  function addBlock(head, quiet = false) {
    const block = make("div", undefined, quiet ? "round quiet" : "round");
    const timing = make("span", "", "muted"); // filled in by took(), at the end of the head line
    head.insertBefore(timing, head.querySelector("button"));
    const soundPart = make("div");
    const speechPart = make("div");
    block.append(head, soundPart, speechPart);
    const took = {}; // path → seconds
    rounds.prepend(block); // newest on top
    while (rounds.children.length > MAX_ROUNDS) rounds.lastChild.remove();

    const line = (part, text, className = "round-line") => part.append(make("div", text, className));

    return {
      // How long a path took, from the segment being cut to the result (step 8).
      // Shown at the end of the head line: "· sound 0.4 s · image 1.8 s"
      took(path, ms) {
        took[path] = (ms / 1000).toFixed(1);
        timing.textContent = Object.entries(took).map(([name, seconds]) => `· ${name} ${seconds} s `).join("");
      },

      // A one-line remark, e.g. why this round was skipped
      note(text, part = "sound") {
        line(part === "speech" ? speechPart : soundPart, text, "round-line muted");
      },

      // The sound path's result: the chosen sound and the top candidates.
      // Each line: chance of being drawn, score (raw score in brackets when centering
      // is on), freshness bonus, category · title, and ✓ on the one drawn.
      sound({ candidates, chosen, resting, centering, ms }) {
        const restNote = resting ? ` · ${resting} resting` : "";
        line(soundPart, `♪ ${chosen.sound.title} · CLAP ${ms} ms${restNote}`);
        for (const candidate of candidates.slice(0, 3)) {
          const chance = `${Math.round(candidate.probability * 100)}%`.padStart(4);
          const raw = centering ? ` (${candidate.raw.toFixed(2)})` : "";
          const bonus = candidate.bonus ? ` +${candidate.bonus.toFixed(3)}` : "";
          const mark = candidate === chosen ? " ✓" : "";
          line(
            soundPart,
            `  ${chance}  ${candidate.score.toFixed(3)}${raw}${bonus}  ${candidate.sound.category} · ${candidate.sound.title}${mark}`,
            "round-line muted",
          );
        }
      },

      // What Whisper heard: the text, the language, how many seconds it listened to
      // (the last 10 s, or 5 s after a quiet round), how long it took.
      // ignored: the raw text, when it was thrown away as a hallucination.
      speech({ text, language, seconds, ms, ignored, typed }) {
        if (typed) return line(speechPart, `“${text}”`, "round-line wrap");
        const timing = `heard ${Math.round(seconds)} s · Whisper ${ms} ms`;
        if (ignored) return line(speechPart, `“${ignored}” ignored (Whisper hears this in noise) · ${timing}`, "round-line muted");
        if (!text) return line(speechPart, `nothing understood · ${timing}`, "round-line muted");
        line(speechPart, `“${text}” · ${language} · ${timing}`, "round-line wrap");
      },

      // The labels closest to what was said, best first (the local text model)
      label({ ranking, ms, source }) {
        const top = ranking.slice(0, 3).map((entry) => `${entry.id} ${entry.score.toFixed(2)}`).join(" · ");
        line(speechPart, `→ ${top}  (${source}, ${ms} ms)`);
      },

      // The LLM's choice, which replaces the local one. from: "LLM" (asked now),
      // "remembered" (asked before) or "repeated" (part of the last sentence asked)
      llm({ id, ms, tokens, from }) {
        const how = {
          LLM: `LLM, ${ms} ms · ${tokens?.prompt} + ${tokens?.answer} tokens`,
          remembered: "LLM, remembered from before: no tokens",
          repeated: "LLM, same as the sentence before: no tokens",
        }[from];
        line(speechPart, `⇒ ${id}  (${how})`);
      },

      // The image shown for the label, and how many are left in its shuffle bag
      image({ image, left, total }) {
        line(speechPart, `▣ ${image.label} · ${image.title}  (${left} of ${total} left in the bag)`, "round-line muted");
      },
    };
  }
}
