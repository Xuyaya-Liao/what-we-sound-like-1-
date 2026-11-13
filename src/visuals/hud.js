// hud.js: the embedding HUD (step 10) — a visible trace of what the machine is
// actually comparing each round, in the style of a computer-vision debug overlay
// (tracking boxes scattered over the frame, a crossing network of thin lines,
// small data readouts). Always on. Boxes are NOT laid out in tidy columns and
// NOT eased smoothly — see "Layout" and "Motion" below; a neat, calm HUD read as
// generic rather than like something glitchily alive (feedback 2026-11-13).
//
// Unlike the shader (image.frag), which only ever shows a MOOD derived from the
// numbers, this layer shows the numbers themselves: the sound candidates CLAP
// ranked, the labels the text model ranked, which ones were finally chosen, and
// — now for every candidate PAIR, not just the chosen one — how well they match.
// It is deliberately real data, not decoration.
//
// It is a plain 2D canvas, NOT part of the WebGL shader: drawing crisp small text
// in GLSL is painful, and a 2D canvas stacked on top (see .visuals-hud in
// style.css) is simple, cheap and exactly as sharp as any other web text.
//
// Each image selection adds one generation. HUD motion runs at a steady pace.

const MAX_GENERATIONS = 3; // how many recent rounds can be on screen at once
const MIN_LIFESPAN_SECONDS = 3.2;
const MAX_LIFESPAN_SECONDS = 8.4;
const MAX_ENTRY_DELAY = 0.75;
const MAX_HANDOFF_DELAY = 1.0;
const MAX_SHOWN = 10;
const BOX_SCALE = 3.5;
const BOX_BEATS_PER_SECOND = 6;
const LINK_BEATS_PER_SECOND = 4;
const JITTER_PIXELS = 5;

// container: the element the canvas goes into
export function createHud(container) {
  const canvas = document.createElement("canvas");
  canvas.className = "visuals-hud";
  container.append(canvas);
  const ctx = canvas.getContext("2d");

  let generations = []; // newest first; each built once in addRound, see buildGeneration

  function resize() {
    canvas.width = container.clientWidth;
    canvas.height = container.clientHeight;
  }
  resize();

  return {
    resize,

    // Sound entries carry a clip ID, category, CLAP score and draw probability.
    // Extra ranked clips outside the draw have zero probability.
    addRound(data) {
      const next = buildGeneration(data);
      if (!next.boxes.length) return;
      if (generations.length) generations[0].replacedAt = next.since;
      generations.unshift(next);
      generations = generations.slice(0, MAX_GENERATIONS);
    },

    draw(now) {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      generations = generations.filter(({ since, replacedAt }) =>
        replacedAt === undefined ||
        now < Math.max(since + MAX_LIFESPAN_SECONDS * 1000, replacedAt + MAX_HANDOFF_DELAY * 1000),
      );
      // Oldest drawn first, so the newest generation's lines and boxes end up on top
      for (let i = generations.length - 1; i >= 0; i--) {
        drawGeneration(ctx, generations[i], now, canvas.width, canvas.height);
      }
    },
  };
}

function buildGeneration({ soundCandidates, labelCandidates, chosenSoundId, chosenLabel, mismatch, match }) {
  const variation = Math.random() * 10000;
  const soundBoxes = layoutBoxes(topWithChosen(soundCandidates, chosenSoundId), "sound", chosenSoundId, variation);
  const labelBoxes = layoutBoxes(topWithChosen(weighted(labelCandidates), chosenLabel), "label", chosenLabel, variation);

  // Each box links to its best match on the opposite side. Draw mutual links once.
  const links = new Map();
  const connect = (soundBox, labelBox) => {
    if (!soundBox || !labelBox) return;
    const key = JSON.stringify([soundBox.id, labelBox.id]);
    if (!links.has(key)) links.set(key, makeLink(soundBox, labelBox, match));
  };
  for (const soundBox of soundBoxes) connect(soundBox, bestMatch(soundBox, labelBoxes, match));
  for (const labelBox of labelBoxes) connect(bestMatch(labelBox, soundBoxes, match), labelBox);
  connect(soundBoxes.find((box) => box.chosen), labelBoxes.find((box) => box.chosen));

  const retainedSound = soundBoxes.find((box) => box.chosen) ?? soundBoxes.find((box) => box.rank === 0);
  const retainedLabel = labelBoxes.find((box) => box.chosen) ?? labelBoxes.find((box) => box.rank === 0);
  // Start with one box immediately so the handoff has a visible successor.
  const first = retainedLabel ?? retainedSound;
  if (first) first.appearsAfter = 0;

  return {
    since: performance.now(),
    boxes: [...soundBoxes, ...labelBoxes],
    links: [...links.values()],
    retained: new Set([retainedSound, retainedLabel]),
    mismatch,
  };
}

function topWithChosen(list, chosenId) {
  const top = list.slice(0, MAX_SHOWN);
  if (!top.some((entry) => entry.id === chosenId)) {
    const chosen = list.find((entry) => entry.id === chosenId);
    if (chosen) top[top.length - 1] = chosen;
  }
  return top;
}

// Labels don't carry a real "probability of being chosen" the way sound
// candidates do (sound-choice.js actually draws from one) — a softmax over
// their scores, for sizing only, is the closest visual equivalent.
function weighted(labelCandidates) {
  const scores = labelCandidates.map((c) => c.score);
  const max = Math.max(...scores);
  const weights = scores.map((s) => Math.exp((s - max) / 0.08));
  const total = weights.reduce((sum, w) => sum + w, 0);
  return labelCandidates.map((c, i) => ({ ...c, weight: weights[i] / total }));
}

// Spread candidates across both axes, with the sound and label regions overlapping.
function layoutBoxes(candidates, kind, chosenId, variation) {
  const region = kind === "sound" ? [0.005, 0.68] : [0.32, 0.995];
  const entries = candidates.map((candidate, rank) => ({
    candidate, rank, seed: hashSeed(`${kind}:${candidate.id}`),
  }));
  const byY = [...entries].sort((a, b) => hashFloat(a.seed * 3.17) - hashFloat(b.seed * 3.17));
  const ySlots = new Map(byY.map((entry, index) => [entry, index]));
  return entries.sort((a, b) => a.seed - b.seed).map((entry, xSlot) => {
    const { candidate, rank, seed } = entry;
    const chosen = candidate.id === chosenId;
    const x = mix(...region, slotPosition(xSlot, entries.length, seed * 12.9898));
    const y = mix(0.005, 0.995, slotPosition(ySlots.get(entry), entries.length, seed * 78.233));
    const priority = 1 - rank / Math.max(1, entries.length - 1);
    const opacity = chosen ? 1 : mix(0.48, 0.9, priority);
    const lifetime = mix(MIN_LIFESPAN_SECONDS, MAX_LIFESPAN_SECONDS, hashFloat(seed + variation));
    const appearsAfter = mix(0.04, MAX_ENTRY_DELAY, hashFloat(seed + variation + 53.9));
    const handoffDelay = mix(0.2, MAX_HANDOFF_DELAY, hashFloat(seed + variation + 109.4));
    return makeBox(candidate, { kind, chosen, seed, x, y, rank, opacity, lifetime, appearsAfter, handoffDelay });
  });
}

function slotPosition(index, count, seed) {
  return (index + mix(0.12, 0.88, hashFloat(seed))) / count;
}

function makeBox(candidate, placement) {
  const { chosen, seed } = placement;
  const size = BOX_SCALE * (mix(9, 30, Math.min(1, candidate.weight * 1.6)) + (chosen ? 5 : 0));
  const aspect = Math.sqrt(mix(0.65, 2.2, hashFloat(seed * 3.71)));
  const source = candidate.association ? " match" : "";
  const label = `${candidate.category ?? candidate.id}${source} ${candidate.score.toFixed(2)}`;
  return { ...placement, id: candidate.id, category: candidate.category, width: size * aspect, height: size / aspect, label };
}

// Of the boxes on the other side, which does this one match best? (real data:
// the category↔label match table, the same one mismatch is built from)
function bestMatch(box, otherSide, match) {
  let best;
  let bestScore = -Infinity;
  for (const other of otherSide) {
    const categoryId = box.kind === "sound" ? box.category : other.category;
    const labelId = box.kind === "sound" ? other.id : box.id;
    const score = match(categoryId, labelId);
    if (score > bestScore) {
      bestScore = score;
      best = other;
    }
  }
  return best;
}

function makeLink(from, to, match) {
  const mismatch = 1 - match(from.category, to.id);
  const anchor = from.chosen && to.chosen;
  // Give each link a distinct pulse.
  const seed = hashSeed(`${from.kind}:${from.id}>${to.id}`);
  return { from, to, mismatch, seed, anchor };
}

// ---- Drawing ----

function drawGeneration(ctx, generation, now, width, height) {
  const age = (now - generation.since) / 1000;
  const t = now / 1000;
  const sinceReplacement = (now - (generation.replacedAt ?? Infinity)) / 1000;
  const depth = sinceReplacement >= 0 ? 0.72 : 1;
  const positions = new Map();
  for (const box of generation.boxes) {
    const visible = generation.retained.has(box)
      ? sinceReplacement < box.handoffDelay
      : age < box.lifetime;
    if (age >= box.appearsAfter && visible) {
      positions.set(box, boxFrame(box, width, height, t, depth));
    }
  }
  for (const link of generation.links) {
    const from = positions.get(link.from);
    const to = positions.get(link.to);
    if (from && to) drawLink(ctx, link, from, to, t);
  }
  for (const [box, frame] of positions) drawBox(ctx, box, frame, generation.mismatch);
}

// Links and rectangles share each frame's jittered positions.
function boxFrame(box, width, height, t, depth) {
  const beat = Math.floor(t * BOX_BEATS_PER_SECOND + hashFloat(box.seed));
  const seed = box.seed + beat * 2.17;
  const viewportScale = Math.min(1, width / 650, height / 450);
  const scale = viewportScale * mix(0.92, 1.08, hashFloat(seed));
  const boxWidth = box.width * scale;
  const boxHeight = box.height * scale;
  const jitterX = mix(-JITTER_PIXELS, JITTER_PIXELS, hashFloat(seed + 16.2));
  const jitterY = mix(-JITTER_PIXELS, JITTER_PIXELS, hashFloat(seed + 23.7));
  const x = Math.max(boxWidth / 2 + 4, Math.min(width - boxWidth / 2 - 4, box.x * width + jitterX));
  const y = Math.max(boxHeight / 2 + 4, Math.min(height - boxHeight / 2 - 4, box.y * height + jitterY));
  const opacity = box.opacity * depth;
  return { x, y, width: boxWidth, height: boxHeight, opacity };
}

function drawBox(ctx, box, { x, y, width, height, opacity }, mismatch) {
  const left = x - width / 2;
  const top = y - height / 2;
  ctx.strokeStyle = mismatchColour(mismatch, opacity);
  ctx.lineWidth = box.chosen ? 2.2 : 1.5;
  ctx.strokeRect(left, top, width, height);

  ctx.font = `${box.chosen ? 12 : 11}px "Courier New", monospace`;
  ctx.textBaseline = "top";
  ctx.textAlign = "left";
  ctx.fillStyle = `rgba(244, 247, 246, ${opacity})`;
  ctx.fillText(box.label, left + 4, top + 4);
}

// Keep the network readable over the image while secondary links pulse.
// Each link uses its own mismatch color, with the selected pair emphasized.
function drawLink(ctx, link, from, to, t) {
  const beat = Math.floor(t * LINK_BEATS_PER_SECOND + hashFloat(link.seed));

  const jaggedness = link.mismatch * 20;
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const length = Math.hypot(dx, dy) || 1;
  const perpX = -dy / length;
  const perpY = dx / length;
  const segments = 7;
  const wiggleSeed = link.seed + beat * 1.9;

  ctx.beginPath();
  ctx.moveTo(from.x, from.y);
  for (let i = 1; i < segments; i++) {
    const f = i / segments;
    const along = (hashFloat(wiggleSeed + f * 11.0) - 0.5) * jaggedness;
    ctx.lineTo(from.x + dx * f + perpX * along, from.y + dy * f + perpY * along);
  }
  ctx.lineTo(to.x, to.y);
  const pulse = mix(0.8, 0.94, hashFloat(link.seed + beat * 3.73));
  const alpha = link.anchor ? Math.min(from.opacity, to.opacity) : Math.min(from.opacity, to.opacity) * pulse;
  ctx.strokeStyle = mismatchColour(link.mismatch, alpha);
  ctx.lineWidth = link.anchor ? 2.6 : 1.6;
  ctx.stroke();

  if (link.anchor) {
    const midX = (from.x + to.x) / 2;
    const midY = (from.y + to.y) / 2;
    ctx.font = "11px \"Courier New\", monospace";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillStyle = mismatchColour(link.mismatch, alpha);
    ctx.fillText(`mismatch ${link.mismatch.toFixed(2)}`, midX, midY);
  }
}

// White at mismatch 0, bright red at 1. Boxes use the round's mismatch;
// links and the selected pair's readout use the pair's own mismatch.
function mismatchColour(mismatch, alpha) {
  const r = 255;
  const g = Math.round(255 - 215 * mismatch);
  const b = Math.round(255 - 215 * mismatch);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

function mix(a, b, t) {
  return a + (b - a) * t;
}

// Turns a number into another 0–1 pseudo-random number, stable for the same
// input — used for everything from "where is this box" to "is this link lit
// up this beat". Safe to use freely here (unlike in the GLSL shaders): this
// runs in JavaScript's doubles, not GPU floats, so it doesn't show the
// precision artifacts the same formula caused in image.frag.
function hashFloat(n) {
  const x = Math.sin(n) * 43758.5453123;
  return x - Math.floor(x);
}

// Turns an id (e.g. "geothermal") into a small, stable number to seed hashFloat with.
function hashSeed(id) {
  let hash = 0;
  for (let i = 0; i < id.length; i++) hash = (hash * 31 + id.charCodeAt(i)) % 100000;
  return hash;
}
