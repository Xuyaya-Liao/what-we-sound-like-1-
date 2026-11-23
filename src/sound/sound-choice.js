// sound-choice.js: picks which nature sound to play, given the CLAP vector of the voice.
//
// 1. Score every library sound against the voice (1 = very alike).
//    With centering on (the default), the score compares how this voice differs
//    from an average voice with how each sound differs from an average nature sound.
// 2. Keep the closest few (pool). Anything further down is too unlike the voice to
//    be played, however long ago it was heard.
// 3. Skip sounds that are resting (played in the last restRounds rounds).
// 4. Of the rest, take the best few (candidates) and add a freshness bonus: the
//    longer since a sound was heard (or if never), the bigger, up to freshBonus.
// 5. Draw one at random. Better scores are likelier, but not certain: each candidate
//    gets weight e^(score / temperature), and its chance is its share of the total.
//    (This is the "softmax" used all over machine learning.)
//
// Why centering? Every voice shares a big "this is someone talking" part, and every
// library sound a big "this is a field recording" part. Raw scores are dominated by
// those shared parts, so all voices land on the same one or two voice-like sounds.
// Subtracting the averages leaves what is particular: breathy, sharp, low, fast…
// Tested with 23 reference voice windows: 2 different first choices raw, 11 centered.

import { CONFIG } from "../config.js";

// Loads data/sound-vectors.json and attaches each vector to its sound from the library.
// Returns { sounds, libraryMean, voiceMean }.
export async function loadSoundVectors(library) {
  // "no-cache": always ask the server whether the file changed (after npm run build),
  // instead of silently reusing an old copy the browser kept
  const response = await fetch("./data/sound-vectors.json", { cache: "no-cache" });
  if (!response.ok) {
    throw new Error(`Could not load data/sound-vectors.json (HTTP ${response.status}). Run npm run build:vectors.`);
  }
  const data = await response.json();
  if (data.model !== CONFIG.models.sound || data.dtype !== CONFIG.soundDtype) {
    throw new Error(
      `data/sound-vectors.json was made with ${data.model} (${data.dtype}), ` +
        `but config.js uses ${CONFIG.models.sound} (${CONFIG.soundDtype}). Run npm run build:vectors.`,
    );
  }
  if (!data.libraryMean || !data.voiceMean) {
    throw new Error("data/sound-vectors.json is from an older version. Run npm run build:vectors.");
  }
  const libraryMean = Float32Array.from(data.libraryMean);
  const sounds = library.sounds
    .filter((sound) => data.vectors[sound.id])
    .map((sound) => {
      const vector = Float32Array.from(data.vectors[sound.id]);
      return { ...sound, vector, centered: centered(vector, libraryMean) };
    });
  return { sounds, libraryMean, voiceMean: Float32Array.from(data.voiceMean) };
}

function similarity(a, b) {
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += a[i] * b[i];
  return sum;
}

// Subtract the average, then scale back to length 1
function centered(vector, mean) {
  const result = vector.map((value, i) => value - mean[i]);
  const length = Math.hypot(...result);
  return result.map((value) => value / length);
}

export function createSoundChooser({ sounds, voiceMean: referenceVoiceMean }) {
  const { centering, voiceAdapt, pool, candidates: candidateCount, restRounds, freshBonus, freshRounds, temperature } =
    CONFIG.soundChoice;
  const lastPlayed = new Map(); // sound id → the round it was last chosen in
  let round = 0; // counts voice rounds
  let voiceMean = Float32Array.from(referenceVoiceMean); // drifts towards the current visitor

  // How many rounds since this sound was chosen (Infinity if never)
  const roundsSince = (id) => (lastPlayed.has(id) ? round - lastPlayed.get(id) : Infinity);

  // e.g. never heard: +0.03 · heard 12 rounds ago: +0.015 · heard 24 or more rounds ago: +0.03
  const bonusFor = (id) => freshBonus * Math.min(1, roundsSince(id) / freshRounds);

  // Picks one entry at random, each with probability entry.probability (they add up to 1)
  function draw(entries) {
    let ticket = Math.random();
    for (const entry of entries) {
      ticket -= entry.probability;
      if (ticket <= 0) return entry;
    }
    return entries[entries.length - 1];
  }

  return {
    // Start over (e.g. when a new visitor begins): reference voice, nothing resting
    reset() {
      voiceMean = Float32Array.from(referenceVoiceMean);
      lastPlayed.clear();
      round = 0;
    },

    // query: the voice's CLAP vector.
    // Returns { candidates, chosen, resting, centering }; each candidate is
    // { sound, score, raw, bonus, adjusted, probability } (score is centered if centering is on),
    // and resting is how many of the closest sounds were skipped because they just played.
    choose(query) {
      round++;
      const centeredQuery = centered(query, voiceMean);
      const ranking = sounds
        .map((sound) => {
          const raw = similarity(query, sound.vector);
          const score = centering ? similarity(centeredQuery, sound.centered) : raw;
          return { sound, score, raw };
        })
        .sort((a, b) => b.score - a.score)
        .slice(0, pool);

      // Skip resting sounds. If everything close is resting (rare), fall back to
      // whatever rested longest.
      let awake = ranking.filter((entry) => roundsSince(entry.sound.id) > restRounds);
      if (!awake.length) awake = [...ranking].sort((a, b) => roundsSince(b.sound.id) - roundsSince(a.sound.id));

      const candidates = awake.slice(0, candidateCount).map((entry) => {
        const bonus = bonusFor(entry.sound.id);
        return { ...entry, bonus, adjusted: entry.score + bonus };
      });

      // Softmax: weight e^(adjusted / temperature), then each weight's share of the total.
      // Subtracting the best score first keeps the numbers small; it doesn't change the shares.
      const best = Math.max(...candidates.map((candidate) => candidate.adjusted));
      const weights = candidates.map((candidate) => Math.exp((candidate.adjusted - best) / temperature));
      const total = weights.reduce((sum, weight) => sum + weight, 0);
      candidates.forEach((candidate, i) => (candidate.probability = weights[i] / total));
      candidates.sort((a, b) => b.probability - a.probability);

      const chosen = draw(candidates);
      lastPlayed.set(chosen.sound.id, round);

      // Let the average voice drift a little towards this voice
      for (let i = 0; i < voiceMean.length; i++) {
        voiceMean[i] += voiceAdapt * (query[i] - voiceMean[i]);
      }
      // Expose close matches for the HUD while keeping the same playback draw.
      const candidateIds = new Set(candidates.map(({ sound }) => sound.id));
      const otherMatches = ranking.filter(({ sound }) => !candidateIds.has(sound.id));
      // compared: the vector the sounds were actually compared with (centered, when
      // centering is on), for the sound screen's vector ring (DESIGN-two-screens.md)
      const compared = centering ? centeredQuery : query;
      return { candidates, chosen, otherMatches, resting: ranking.length - awake.length, centering, compared };
    },
  };
}
