// check-speech.mjs: finds library sounds with people talking (or singing, laughing…) in them,
// and leaves them out of the site.
//
//     npm run check:speech              (check, and update config/excluded.json)
//     npm run check:speech -- --report  (only print the scores, change nothing)
//
// Why: a nature recording with voices in it sounds like every visitor, so it gets
// chosen over and over (the Alishan and Icy Water clips did exactly that).
//
// How: AST (Audio Spectrogram Transformer) is a model trained on AudioSet, a large
// collection of YouTube sounds labelled with 527 categories, including "Speech",
// "Conversation", "Male speech, man speaking", "Crowd"… For each clip it gives a
// score from 0 to 1 per category. We take the highest score among the human-voice
// categories. Above THRESHOLD, the clip's whole recording is excluded.
//
// Only entries whose reason starts with "auto:" are written by this script; entries
// you add by hand to config/excluded.json are kept. Results are cached in tools/.cache.
// Run npm run build afterwards (npm run build also runs this check first).

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { AutoModelForAudioClassification, AutoProcessor } from "@huggingface/transformers";
import { readWav, resample, toMono } from "./lib/wav.mjs";
import { EXCLUDED_FILE, PROJECT, readCsv, snapshotFolder } from "./lib/snapshot.mjs";

const MODEL = "Xenova/ast-finetuned-audioset-10-10-0.4593";
const RATE = 16000; // AST listens at 16 kHz
const THRESHOLD = 0.2; // a voice score above this excludes the recording (see README for how it was chosen)
const VOICE_LABELS = /speech|speaking|conversation|narration|babbl|whisper|chatter|hubbub|laugh|giggle|chuckle|shout|yell|singing|choir|crowd/i;
const CACHE = path.join(PROJECT, "tools/.cache/speech-ast.json");
const reportOnly = process.argv.includes("--report");
if (reportOnly) process.argv.splice(process.argv.indexOf("--report"), 1);

const snapshot = snapshotFolder();
const rows = readCsv(path.join(snapshot, "manifest.csv")).filter((row) => row.kind === "sound");
const cache = fs.existsSync(CACHE) ? JSON.parse(fs.readFileSync(CACHE, "utf8")) : {};

console.log(`Checking ${rows.length} sounds in ${path.basename(snapshot)} for human voices (${MODEL}).`);
console.log("The first run downloads the model, which takes a while.");

let model;
async function voiceScore(file) {
  model ??= await Promise.all([
    AutoProcessor.from_pretrained(MODEL),
    AutoModelForAudioClassification.from_pretrained(MODEL, { dtype: "q8" }),
  ]);
  const [processor, network] = model;
  const { sampleRate, channels } = readWav(file);
  const samples = resample(toMono(channels), sampleRate, RATE);
  const { logits } = await network(await processor(samples));
  // AST can hear several things at once, so each category gets its own 0–1 score (a "sigmoid")
  let best = { label: "", score: 0 };
  logits.data.forEach((logit, index) => {
    const label = network.config.id2label[index];
    const score = 1 / (1 + Math.exp(-logit));
    if (VOICE_LABELS.test(label) && score > best.score) best = { label, score };
  });
  return best;
}

// ---- Score every sound (cached by file content) ----
const results = [];
for (const [index, row] of rows.entries()) {
  const file = path.join(snapshot, row.file);
  if (!fs.existsSync(file)) continue;
  const key = crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
  cache[key] ??= await voiceScore(file);
  results.push({ row, ...cache[key] });
  process.stdout.write(`\rChecked ${index + 1}/${rows.length}`);
}
process.stdout.write("\n");
fs.mkdirSync(path.dirname(CACHE), { recursive: true });
fs.writeFileSync(CACHE, JSON.stringify(cache));

// ---- Report ----
results.sort((a, b) => b.score - a.score);
console.log(`\nHighest voice scores (✗ = above ${THRESHOLD}, excluded):`);
for (const { row, label, score } of results.slice(0, 25)) {
  const mark = score >= THRESHOLD ? "✗" : " ";
  console.log(`  ${mark} ${score.toFixed(3)}  ${label.padEnd(28).slice(0, 28)}  ${row.source_id.padEnd(12)}  ${row.search_label} · ${row.source_name.slice(0, 45)}`);
}

// ---- Update config/excluded.json ----
const voiced = results.filter((result) => result.score >= THRESHOLD);
if (reportOnly) {
  console.log(`\n${voiced.length} sounds are above the threshold. --report: nothing was changed.`);
} else {
  const config = JSON.parse(fs.readFileSync(EXCLUDED_FILE, "utf8"));
  // Keep hand-written entries, replace the automatic ones
  const kept = Object.fromEntries(Object.entries(config.excluded).filter(([, reason]) => !reason.startsWith("auto:")));
  const automatic = {};
  for (const { row, label, score } of voiced) {
    if (kept[row.source_id] || automatic[row.source_id]) continue; // the whole recording is already out
    automatic[row.source_id] = `auto: AST heard "${label}" (${score.toFixed(2)}) · ${row.search_label} · ${row.source_name}`;
  }
  config.excluded = { ...kept, ...automatic };
  fs.writeFileSync(EXCLUDED_FILE, JSON.stringify(config, null, 2) + "\n");
  console.log(`\nExcluded ${Object.keys(automatic).length} recordings automatically (plus ${Object.keys(kept).length} by hand) in config/excluded.json.`);
  console.log("Run npm run build to rebuild the library without them.");
}
