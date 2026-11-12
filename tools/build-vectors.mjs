// build-vectors.mjs: computes the CLAP vector of every sound in the library, once,
// so the website does not have to (see README: "Why precompute?").
//
//     npm run build:vectors
//
// Run it after npm run build:assets. It reads data/manifest.json, runs CLAP on
// each file in assets/sounds, and writes data/sound-vectors.json with:
//   - one vector per library sound
//   - libraryMean: the average library vector  ┐ used for "centering"
//   - voiceMean: the average reference voice   ┘ (see README: "Centering")
//
// It also prints two checks:
//   1. Nearest neighbour: does each sound's closest match share its category?
//   2. Reference voices: how many different sounds win across many voice windows,
//      without and with centering?
// (Sounds with human voices in them are found by npm run check:speech, before this.)
//
// Results are cached in tools/.cache, keyed by the file's content, so re-running
// only computes sounds that are new or changed.

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { readWav, resample, toMono } from "./lib/wav.mjs";
import {
  CLAP_DTYPE, CLAP_MODEL, CLAP_RATE, CLAP_SECONDS,
  centered, embedSound, meanVector, similarity,
} from "./lib/clap.mjs";

const PROJECT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const MANIFEST = path.join(PROJECT, "data/manifest.json");
const OUTPUT = path.join(PROJECT, "data/sound-vectors.json");
const CACHE = path.join(PROJECT, `tools/.cache/clap-${CLAP_DTYPE}.json`);
const VOICES = path.join(PROJECT, "tools/reference-voices");

const WINDOW = CLAP_RATE * CLAP_SECONDS; // samples in 5 seconds
const { sounds } = JSON.parse(fs.readFileSync(MANIFEST, "utf8"));
const cache = fs.existsSync(CACHE) ? JSON.parse(fs.readFileSync(CACHE, "utf8")) : {};
const hash = (bytes) => crypto.createHash("sha256").update(bytes).digest("hex");
const short = (sound) => `${sound.category} · ${sound.title.slice(0, 50)}`;

console.log(`Loading ${CLAP_MODEL} (${CLAP_DTYPE}). The first run downloads it, which takes a while.`);
const started = Date.now();
let computed = 0;

// Returns the CLAP vector of some samples, from the cache when possible
async function cachedVector(key, getSamples) {
  if (!cache[key]) {
    cache[key] = (await embedSound(getSamples())).map((value) => Number(value.toFixed(5)));
    computed++;
  }
  return cache[key];
}

// ---- Library sounds ----
const vectors = {};
for (const [index, sound] of sounds.entries()) {
  const file = path.join(PROJECT, sound.file);
  vectors[sound.id] = await cachedVector(hash(fs.readFileSync(file)), () => {
    const { sampleRate, channels } = readWav(file);
    if (sampleRate !== CLAP_RATE) throw new Error(`${sound.file} is ${sampleRate} Hz; CLAP needs ${CLAP_RATE} Hz`);
    return toMono(channels).subarray(0, WINDOW);
  });
  process.stdout.write(`\rLibrary ${index + 1}/${sounds.length}`);
}
process.stdout.write("\n");

// ---- Reference voices: every 5-second window (one per second) with sound in it ----
const voiceVectors = [];
const voiceFiles = fs.existsSync(VOICES) ? fs.readdirSync(VOICES).filter((name) => name.toLowerCase().endsWith(".wav")) : [];
for (const name of voiceFiles) {
  const bytes = fs.readFileSync(path.join(VOICES, name));
  const { sampleRate, channels } = readWav(path.join(VOICES, name));
  const samples = resample(toMono(channels), sampleRate, CLAP_RATE);
  const lastStart = Math.max(0, samples.length - WINDOW);
  for (let start = 0; start <= lastStart; start += CLAP_RATE) {
    const window = samples.subarray(start, start + WINDOW);
    const rms = Math.sqrt(window.reduce((sum, value) => sum + value * value, 0) / window.length);
    if (rms < 0.003) continue; // mostly silence
    voiceVectors.push(await cachedVector(`${hash(bytes)}@${start}`, () => window));
    process.stdout.write(`\rReference voices: ${voiceVectors.length} windows`);
  }
}
process.stdout.write("\n");
if (!voiceVectors.length) throw new Error("No reference voices found in tools/reference-voices (WAV files)");

fs.mkdirSync(path.dirname(CACHE), { recursive: true });
fs.writeFileSync(CACHE, JSON.stringify(cache));

// ---- Write data/sound-vectors.json ----
// The model settings are saved too, so the website can check it is using the same ones.
const round = (vector) => vector.map((value) => Number(value.toFixed(5)));
const libraryMean = meanVector(Object.values(vectors));
const voiceMean = meanVector(voiceVectors);
fs.writeFileSync(
  OUTPUT,
  JSON.stringify({
    model: CLAP_MODEL,
    dtype: CLAP_DTYPE,
    sampleRate: CLAP_RATE,
    clipSeconds: CLAP_SECONDS,
    generatedAt: new Date().toISOString(),
    libraryMean: round(libraryMean),
    voiceMean: round(voiceMean),
    referenceVoiceWindows: voiceVectors.length,
    vectors,
  }),
);

const seconds = ((Date.now() - started) / 1000).toFixed(0);
const size = (fs.statSync(OUTPUT).size / 1024).toFixed(0);
console.log(`Computed ${computed} vectors, reused the rest from cache (${seconds} s)`);
console.log(`Wrote ${path.relative(PROJECT, OUTPUT)} (${size} KB)`);

// ---- Check 1: nearest neighbour ----
// For every sound, find the most similar OTHER sound in the library.
// If CLAP works, that neighbour usually belongs to the same category.
const agree = {};
for (const sound of sounds) {
  let best;
  for (const other of sounds) {
    if (other.id === sound.id) continue;
    const score = similarity(vectors[sound.id], vectors[other.id]);
    if (!best || score > best.score) best = { other, score };
  }
  const stats = (agree[sound.category] ??= { same: 0, total: 0 });
  stats.total++;
  if (best.other.category === sound.category) stats.same++;
}
const same = Object.values(agree).reduce((sum, stats) => sum + stats.same, 0);
console.log(`\n1. Nearest neighbour has the same category: ${same}/${sounds.length} (${Math.round((100 * same) / sounds.length)}%)`);
const weakest = Object.entries(agree).sort((a, b) => a[1].same / a[1].total - b[1].same / b[1].total).slice(0, 4);
console.log(`   Most mixed categories: ${weakest.map(([category, s]) => `${category} ${s.same}/${s.total}`).join(", ")}`);

// ---- Check 2: reference voices, without and with centering ----
function winners(libraryVectors, queries) {
  const counts = {};
  for (const query of queries) {
    let best;
    for (const sound of sounds) {
      const score = similarity(query, libraryVectors[sound.id]);
      if (!best || score > best.score) best = { sound, score };
    }
    counts[best.sound.id] = (counts[best.sound.id] ?? 0) + 1;
  }
  return Object.entries(counts).sort((a, b) => b[1] - a[1]);
}
const centeredLibrary = Object.fromEntries(sounds.map((sound) => [sound.id, centered(vectors[sound.id], libraryMean)]));
const raw = winners(vectors, voiceVectors);
const centeredWins = winners(centeredLibrary, voiceVectors.map((voice) => centered(voice, voiceMean)));
const describe = ([id, count]) => `${count}× ${short(sounds.find((sound) => sound.id === id))}`;
console.log(`\n2. Reference voices (${voiceVectors.length} windows from ${voiceFiles.length} files): how many different sounds come first?`);
console.log(`   raw:      ${raw.length} different · most often ${describe(raw[0])}`);
console.log(`   centered: ${centeredWins.length} different · most often ${describe(centeredWins[0])}`);
