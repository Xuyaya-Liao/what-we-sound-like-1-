// try-sound.mjs: which library sounds does a recording sound like?
//
//     npm run try-sound -- "path/to/recording.wav"
//
// Takes the first 5 seconds of any WAV file, runs CLAP on it, and lists the 5
// closest sounds in the library. This is exactly what the website will do every
// 5 seconds with the microphone; here you can try it on a file, on your computer.
// Handy for the reading experiments: record the same sentence in different moods
// and compare the lists.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readWav, resample, toMono } from "./lib/wav.mjs";
import { CLAP_RATE, CLAP_SECONDS, embedSound, similarity } from "./lib/clap.mjs";

const PROJECT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const file = process.argv[2];
if (!file) {
  console.log('Usage: npm run try-sound -- "path/to/recording.wav"');
  process.exit(1);
}

const { sounds } = JSON.parse(fs.readFileSync(path.join(PROJECT, "data/manifest.json"), "utf8"));
const { vectors } = JSON.parse(fs.readFileSync(path.join(PROJECT, "data/sound-vectors.json"), "utf8"));

const { sampleRate, channels } = readWav(path.resolve(file));
const samples = resample(toMono(channels), sampleRate, CLAP_RATE).subarray(0, CLAP_RATE * CLAP_SECONDS);
const query = await embedSound(samples);

const ranking = sounds
  .map((sound) => ({ sound, score: similarity(query, vectors[sound.id]) }))
  .sort((a, b) => b.score - a.score);

console.log(`\n${path.basename(file)} (first ${CLAP_SECONDS} s) sounds most like:`);
for (const { sound, score } of ranking.slice(0, 5)) {
  console.log(`  ${score.toFixed(3)}  ${sound.category.padEnd(17)} ${sound.title}`);
}
