// build-ring-order.mjs: decides how the sound screen lays out a CLAP vector as a
// ring of 512 rays (two-screen redesign, step 2).
//
//     npm run build:ring      (also part of npm run build, after build:vectors)
//
// CLAP's 512 numbers come in no particular order: drawn in their given order around
// a circle, neighbouring rays have nothing to do with each other, and every voice
// looks like the same random fuzz. This tool reads data/sound-vectors.json and writes
// data/vector-ring.json with two things:
//
//   order: which dimension goes where around the ring. Dimensions that tend to rise
//          and fall together (across the library's sounds) are put next to each
//          other, so a voice's vector comes out as a few broad bulges and dents — a
//          shape that changes as the voice changes, rather than noise.
//   scale: how much each dimension usually varies. The view divides by it, so a ray's
//          length says "how unusual this voice is on this dimension", and a dimension
//          that hardly ever varies doesn't get drowned out by one that always does.
//
// Both are measured on the library sounds, centered (minus the average sound) — the
// same space the sound choice compares in (src/sound/sound-choice.js). No model runs
// here; it takes a second. Re-run it whenever build:vectors has been re-run.
//
// How the order is found: the ring is a closed loop through all 512 dimensions, and
// we want neighbours to be as alike as possible — the "travelling salesman" problem,
// with "distance" = 1 − correlation. A greedy loop (always step to the most alike
// dimension not yet used), then improved with 2-opt (reverse any stretch of the loop
// that makes it shorter), until nothing improves. Not the perfect loop, but close.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PROJECT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const INPUT = path.join(PROJECT, "data/sound-vectors.json");
const OUTPUT = path.join(PROJECT, "data/vector-ring.json");

const data = JSON.parse(fs.readFileSync(INPUT, "utf8"));
const mean = data.libraryMean;
const dims = mean.length;

// Every library sound, centered and scaled back to length 1
const vectors = Object.values(data.vectors).map((vector) => {
  const centered = vector.map((value, i) => value - mean[i]);
  const length = Math.hypot(...centered);
  return centered.map((value) => value / length);
});

// ---- How much each dimension varies, and how alike every two dimensions are ----
const average = new Array(dims).fill(0);
for (const vector of vectors) for (let i = 0; i < dims; i++) average[i] += vector[i] / vectors.length;
const deviation = new Array(dims).fill(0);
for (const vector of vectors) for (let i = 0; i < dims; i++) deviation[i] += (vector[i] - average[i]) ** 2 / vectors.length;
const scale = deviation.map(Math.sqrt);

// correlation[i][j]: 1 = these two always rise and fall together, 0 = unrelated
const standardized = vectors.map((vector) => vector.map((value, i) => (value - average[i]) / scale[i]));
const correlation = Array.from({ length: dims }, () => new Float64Array(dims));
for (let i = 0; i < dims; i++) {
  for (let j = i; j < dims; j++) {
    let sum = 0;
    for (const z of standardized) sum += z[i] * z[j];
    correlation[i][j] = correlation[j][i] = sum / vectors.length;
  }
}
const distance = (a, b) => 1 - correlation[a][b];

// ---- A greedy loop… ----
const used = new Uint8Array(dims);
const loop = [0];
used[0] = 1;
while (loop.length < dims) {
  const last = loop.at(-1);
  let best = -1;
  for (let j = 0; j < dims; j++) if (!used[j] && (best < 0 || distance(last, j) < distance(last, best))) best = j;
  loop.push(best);
  used[best] = 1;
}

// ---- …improved with 2-opt ----
const loopLength = () => loop.reduce((sum, dim, i) => sum + distance(dim, loop[(i + 1) % dims]), 0);
const greedyLength = loopLength();
for (let improved = true, passes = 0; improved && passes < 50; passes++) {
  improved = false;
  for (let i = 0; i < dims - 1; i++) {
    for (let j = i + 2; j < dims; j++) {
      const a = loop[i], b = loop[i + 1], c = loop[j], d = loop[(j + 1) % dims];
      if (a === d) continue;
      // Reversing loop[i+1..j] replaces the links a–b and c–d with a–c and b–d
      if (distance(a, c) + distance(b, d) < distance(a, b) + distance(c, d) - 1e-9) {
        for (let lo = i + 1, hi = j; lo < hi; lo++, hi--) [loop[lo], loop[hi]] = [loop[hi], loop[lo]];
        improved = true;
      }
    }
  }
}

// ---- Check: how alike are neighbours now, and how smooth do real vectors look? ----
const neighbourCorrelation = (order) =>
  order.reduce((sum, dim, i) => sum + correlation[dim][order[(i + 1) % dims]], 0) / dims;
// Roughness: the average jump between neighbouring rays, relative to the rays' own
// spread. About 1.4 for unrelated neighbours; lower = smoother shapes.
const roughness = (order) => {
  let total = 0;
  for (const vector of vectors) {
    const z = order.map((dim) => vector[dim] / scale[dim]);
    const spread = Math.sqrt(z.reduce((sum, value) => sum + value * value, 0) / dims);
    const jumps = z.reduce((sum, value, i) => sum + Math.abs(value - z[(i + 1) % dims]), 0) / dims;
    total += jumps / spread;
  }
  return total / vectors.length;
};
const given = [...Array(dims).keys()];
console.log(`Loop length: greedy ${greedyLength.toFixed(1)} → 2-opt ${loopLength().toFixed(1)} (lower = neighbours more alike)`);
console.log(`Average correlation of neighbouring rays: given order ${neighbourCorrelation(given).toFixed(3)} → ${neighbourCorrelation(loop).toFixed(3)}`);
console.log(`Roughness of the library's shapes: given order ${roughness(given).toFixed(2)} → ${roughness(loop).toFixed(2)}`);

const round = (value) => Number(value.toFixed(6));
fs.writeFileSync(
  OUTPUT,
  JSON.stringify({
    about: "Made by tools/build-ring-order.mjs from data/sound-vectors.json, for the sound screen's vector ring.",
    vectorsGeneratedAt: data.generatedAt, // the view warns if this no longer matches
    order: loop,
    scale: scale.map(round),
  }),
);
console.log(`Wrote ${path.relative(PROJECT, OUTPUT)}`);
