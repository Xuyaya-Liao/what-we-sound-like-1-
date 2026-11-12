// session-stats.js: keeps count of how the piece is keeping up (step 8).
//
// For every round it records how long each path took, from the moment the 5-second
// segment was cut until the visitor can perceive the result:
//   sound: until the chosen nature sound starts playing
//   image: until the chosen image starts fading in
// A path that takes longer than a round (5 s) makes the next round skip that path.
// The debug panel shows the summary line, e.g.
//   12:30 · 150 rounds (98 voice) · sound avg 0.4 s, max 0.9 · image avg 1.8 s, max 3.5 · skipped 0 · memory 410 MB

import { CONFIG } from "./config.js";

// One kind of timing: how many, the average and the slowest
function createTimes() {
  let count = 0;
  let total = 0;
  let max = 0;
  return {
    add(ms) {
      count += 1;
      total += ms;
      max = Math.max(max, ms);
    },
    text(name) {
      if (!count) return `${name} –`;
      const seconds = (ms) => (ms / 1000).toFixed(1);
      return `${name} avg ${seconds(total / count)} s, max ${seconds(max)}`;
    },
  };
}

export function createSessionStats() {
  let started = performance.now();
  let rounds = 0;
  let voiceRounds = 0;
  let late = 0; // results that took longer than one round
  const skipped = { CLAP: 0, Whisper: 0 };
  const times = { sound: createTimes(), image: createTimes() };

  return {
    // A new input started (Begin): start counting from zero
    reset() {
      started = performance.now();
      rounds = voiceRounds = late = 0;
      skipped.CLAP = skipped.Whisper = 0;
      times.sound = createTimes();
      times.image = createTimes();
    },

    round(quiet) {
      rounds += 1;
      if (!quiet) voiceRounds += 1;
    },

    // path: "sound" or "image"; ms: from the segment being cut to the result
    took(path, ms) {
      times[path].add(ms);
      if (ms > CONFIG.roundSeconds * 1000) late += 1;
    },

    // model: "CLAP" or "Whisper", still busy with the previous round
    skip(model) {
      skipped[model] += 1;
    },

    summary() {
      const elapsed = Math.round((performance.now() - started) / 1000);
      const clock = `${Math.floor(elapsed / 60)}:${String(elapsed % 60).padStart(2, "0")}`;
      const skips = skipped.CLAP + skipped.Whisper;
      const skipText = skips ? `skipped ${skipped.CLAP} CLAP, ${skipped.Whisper} Whisper` : "skipped 0";
      const lateText = late ? ` · ${late} late (over ${CONFIG.roundSeconds} s)` : "";
      // performance.memory exists in Chrome and Edge only. It counts this page,
      // not the models' workers.
      const memory = performance.memory ? ` · page memory ${Math.round(performance.memory.usedJSHeapSize / 1e6)} MB` : "";
      return (
        `${clock} · ${rounds} rounds (${voiceRounds} voice) · ${times.sound.text("sound")} · ` +
        `${times.image.text("image")} · ${skipText}${lateText}${memory}`
      );
    },
  };
}
