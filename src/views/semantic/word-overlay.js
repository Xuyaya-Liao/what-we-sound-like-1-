// word-overlay.js: the semantic screen's overlay, drawn over the image
// (step 3 of DESIGN-two-screens.md). It replaces the step-10 embedding HUD.
//
//   · In the centre, a ring of WORDS: what the visitor said, one word per ray. The
//     ring has fixed slots; new words replace the oldest in turn, one after another,
//     like a hand sweeping round a clock face. Each word is written ALONG its ray,
//     reading outwards from the circle (on the left half it is turned round, so it
//     is never upside down). A word's ray is as long as its weight: how similar it
//     is to the label chosen this round (the local text model, which also runs when
//     the LLM chose the label). The heaviest word is gold and gets a HUD box.
//   · Around it, image LABELS as HUD boxes: the chosen one, plus several others
//     (half the next best of the local ranking, half at random). Size = the label's
//     softmax share of the local ranking. Boxes are placed so they don't overlap
//     each other or the ring.
//   · Lines: every label links to the word on the ring that is most similar to IT
//     (not to the centre, unlike the sound screen), meeting the word at its outer
//     end. The chosen label links to the boxed word, in gold. Every other box and
//     line is white → red by how badly that label fits the sound playing now (the
//     same match table as mismatch).
//
// Honest note, also in the design doc: when the LLM is on, the label is the LLM's
// choice, but the weights are the local model's, so they show which word is closest
// to that label, not why the LLM chose it.
//
// A plain 2D canvas over the WebGL image (crisp small text is painful in a shader).
// The ring sits on a soft dark disc, so it stays readable over any photo.
//
// Revised 2026-11-20 after the first look: on a scaled screen (Windows at 150%) the
// whole overlay sat off-centre (a CSS size was missing, see .visuals-hud in
// style.css); words lay flat instead of along their rays; lines met the words at
// their middle; it looked rough; and there were too few labels.

import { CONFIG } from "../../config.js";
import { boxEdge, boxFrame, boxSize, drawBox, goldColour, hashFloat, hashSeed, mismatchColour, mix, softGlow } from "../hud-kit.js";

const LINK_BEATS_PER_SECOND = 4;
const MARGIN = 0.06; // keep label boxes this far (fraction of the shorter side) from the edges
const FONT = '"Courier New", monospace';
const WORD_FONT_PX = 18; // 13 until 2026-11-21: too hard to read from a distance
const WORD_STRETCH = 1.15; // the words' letters drawn this much wider…
const WORD_SQUASH = 0.85; // …and this much flatter than the font (2026-11-21)
const MAX_WORD_CHARS = 12; // longer words are cut short with "…", so a ray never runs off screen

export function createWordOverlay(container) {
  const settings = CONFIG.semanticScreen;
  const canvas = document.createElement("canvas");
  canvas.className = "visuals-hud";
  container.append(canvas);
  const ctx = canvas.getContext("2d");
  let width = 1;
  let height = 1;

  const count = settings.wordSlots;
  // Each slot: { text, scores, since } — since = when its word arrived (for the
  // one-by-one entrance and a brief highlight). Slot 0 is at the top, then clockwise.
  let slots = new Array(count).fill(null);
  let labelIds = []; // the order of each word's scores
  let rounds = []; // newest first: { since, endedAt?, boxes }
  let chosenIndex = -1; // the chosen label's index in labelIds
  let boxedSlot = -1; // the slot of the heaviest word, for the chosen label
  let match = () => 0.5;
  let soundCategory; // the sound playing now, to colour the labels against
  let shownWeights = new Float32Array(count); // each ray's length, easing to its weight
  let lastDraw = 0;
  // Each slot's luck for its word box this round, 0–1, drawn again every round, so
  // which words have a box, and how faint, changes from round to round
  const boxLuck = Float32Array.from({ length: count }, Math.random);

  function resize() {
    width = Math.max(1, container.clientWidth);
    height = Math.max(1, container.clientHeight);
    const density = Math.min(2, window.devicePixelRatio || 1);
    canvas.width = Math.round(width * density);
    canvas.height = Math.round(height * density);
    for (const round of rounds) layOut(round.boxes); // the boxes' places depend on the size
  }
  resize();

  const angleOf = (slot) => -Math.PI / 2 + (2 * Math.PI * slot) / count;
  const weightOf = (slot, labelIndex) => slots[slot]?.scores[labelIndex] ?? -Infinity;
  const geometry = () => {
    const short = Math.min(width, height);
    return { short, radius: short * settings.ringRadius, reach: short * settings.rayReach };
  };

  // The slot whose word is most similar to this label (-1 if the ring is empty)
  function closestSlot(labelIndex) {
    let best = -1;
    for (let slot = 0; slot < count; slot++) {
      if (slots[slot] && (best < 0 || weightOf(slot, labelIndex) > weightOf(best, labelIndex))) best = slot;
    }
    return best;
  }

  // Places a round's boxes, one at a time (the chosen one first): each tries many
  // spots near its own direction, anywhere between the ring (with its longest words)
  // and the screen's edges, and takes the one that overlaps least with the boxes
  // already placed (and with the ring). Writes box.x, box.y (pixels).
  // (2026-11-21: pushing overlapping boxes apart, the first version, got undone by
  // the screen's edges once there were ten boxes, and they ended up stacked.)
  function layOut(boxes) {
    const { short, radius, reach } = geometry();
    const ringOuter = radius + reach + WORD_FONT_PX * MAX_WORD_CHARS * 0.6 + 16;
    const marginPx = short * MARGIN;
    const placed = [];
    const ordered = [...boxes].sort((a, b) => b.chosen - a.chosen);
    for (const box of ordered) {
      const minX = marginPx + box.width / 2;
      const maxX = width - marginPx - box.width / 2;
      const minY = marginPx + box.height / 2;
      const maxY = height - marginPx - box.height / 2;
      let best;
      for (let attempt = 0; attempt < 60; attempt++) {
        // Near its own direction at first, wider and wider later
        const spread = attempt < 25 ? 0.35 : attempt < 45 ? 0.9 : Math.PI;
        const angle = box.angle + (Math.random() - 0.5) * 2 * spread;
        const distance = ringOuter + Math.max(box.width, box.height) / 2 + Math.random() * short;
        const x = Math.max(minX, Math.min(maxX, width / 2 + Math.cos(angle) * distance * (width / short) ** 0.5));
        const y = Math.max(minY, Math.min(maxY, height / 2 + Math.sin(angle) * distance));
        // How much it would overlap: other boxes (with a gap), and the ring's area
        let overlap = 0;
        for (const other of placed) {
          const ox = (box.width + other.width) / 2 + 14 - Math.abs(x - other.x);
          const oy = (box.height + other.height) / 2 + 14 - Math.abs(y - other.y);
          if (ox > 0 && oy > 0) overlap += ox * oy;
        }
        const inside = ringOuter + Math.min(box.width, box.height) / 2 - Math.hypot(x - width / 2, y - height / 2);
        if (inside > 0) overlap += inside * inside * 4;
        if (!best || overlap < best.overlap) best = { x, y, overlap };
        if (overlap === 0 && attempt >= 8) break; // free, and near its direction: good enough
      }
      box.x = best.x;
      box.y = best.y;
      placed.push(box);
    }
  }

  return {
    resize,
    setMatch(lookup) {
      match = lookup;
    },
    setSoundCategory(category) {
      soundCategory = category;
    },

    // The whole ring, as the engine keeps it (src/semantic/words.js). New words come
    // in one after another, in the order they were said.
    setWords({ labels, slots: incoming, added = [] }) {
      labelIds = labels ?? labelIds;
      const now = performance.now();
      const order = new Map(added.map((slot, i) => [slot, i]));
      slots = incoming.map((word, slot) => {
        if (!word) return null;
        const old = slots[slot];
        const isNew = order.has(slot) || !old || old.text !== word.text;
        if (isNew) shownWeights[slot] = 0; // a new word's ray grows out from the circle
        const text = [...word.text].length > MAX_WORD_CHARS ? `${[...word.text].slice(0, MAX_WORD_CHARS - 1).join("")}…` : word.text;
        return { ...word, text, since: isNew ? now + (order.get(slot) ?? 0) * settings.newWordSeconds * 1000 : old.since };
      });
      if (chosenIndex >= 0) boxedSlot = closestSlot(chosenIndex);
    },

    // An image was chosen: its label, and the local ranking (for the other labels
    // and every label's size). Returns where the chosen label's box is, as a
    // fraction of the screen (0–1, 0–1), so the image can spread out from there.
    addRound({ chosenLabel, labelCandidates = [] }) {
      const now = performance.now();
      for (const round of rounds) round.endedAt ??= now;
      chosenIndex = labelIds.indexOf(chosenLabel);
      boxedSlot = chosenIndex >= 0 ? closestSlot(chosenIndex) : -1;
      for (let slot = 0; slot < count; slot++) boxLuck[slot] = Math.random();

      // Which labels to show: the chosen one, half of the others from the top of the
      // ranking, half at random
      const ranked = labelCandidates.filter((entry) => entry.id !== chosenLabel);
      const fromTop = Math.ceil(settings.otherLabels / 2);
      const top = ranked.slice(0, fromTop);
      const rest = ranked.slice(fromTop);
      const random = [];
      while (random.length < settings.otherLabels - top.length && rest.length) {
        random.push(rest.splice(Math.floor(Math.random() * rest.length), 1)[0]);
      }
      const chosenEntry = labelCandidates.find((entry) => entry.id === chosenLabel) ?? { id: chosenLabel, score: 0 };
      const shown = [chosenEntry, ...top, ...random];

      // Size: the label's softmax share of the whole local ranking
      const scores = labelCandidates.map((entry) => entry.score);
      const max = Math.max(...scores, 0);
      const total = scores.reduce((sum, score) => sum + Math.exp((score - max) / 0.08), 0) || 1;
      const weight = (entry) => Math.exp((entry.score - max) / 0.08) / total;

      // Where around the screen (2026-11-21): the boxes are spread evenly round the
      // ring, so they never bunch on one side, even when several link to the same
      // word. The chosen one sits straight out from its boxed word. The others take
      // the remaining even spots in the order of their words around the ring, so
      // their lines fan outwards instead of crossing the ring or each other.
      const wordOf = (entry) => {
        const index = labelIds.indexOf(entry.id);
        return entry.id === chosenLabel ? boxedSlot : index >= 0 ? closestSlot(index) : -1;
      };
      const startAngle = boxedSlot >= 0 ? angleOf(boxedSlot) : Math.random() * 2 * Math.PI;
      const offset = (entry) => {
        const slot = wordOf(entry);
        const angle = slot >= 0 ? angleOf(slot) : startAngle + Math.random() * 2 * Math.PI;
        return (((angle - startAngle) % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
      };
      const others = shown.filter((entry) => entry.id !== chosenLabel).sort((a, b) => offset(a) - offset(b));
      const evenAngle = new Map([[chosenEntry, startAngle]]);
      others.forEach((entry, i) => evenAngle.set(entry, startAngle + (2 * Math.PI * (i + 1)) / shown.length));
      const boxes = shown.map((entry) => {
        const chosen = entry.id === chosenLabel;
        const seed = hashSeed(entry.id) + Math.floor(Math.random() * 1000);
        const index = labelIds.indexOf(entry.id);
        // Sized by weight, but never too small for its two lines of text
        const size = boxSize(weight(entry), chosen, seed);
        const textWidth = (entry.id.length + 1) * (chosen ? 7.4 : 6.8) + 10;
        return {
          width: Math.max(size.width, textWidth),
          height: Math.max(size.height, 34),
          id: entry.id,
          labelIndex: index,
          chosen,
          seed,
          angle: evenAngle.get(entry),
          distance: mix(0.15, 0.95, hashFloat(seed + 7.3)),
          opacity: chosen ? 1 : mix(0.65, 0.9, hashFloat(seed + 1.1)),
          appearsAfter: chosen ? 0 : 0.15 + hashFloat(seed + 2.9) * 0.6,
          label: entry.id.replaceAll("_", " "),
          sublabel: entry.score.toFixed(3),
        };
      });
      layOut(boxes);
      boxes.sort((a, b) => a.chosen - b.chosen); // the chosen one on top
      rounds = [{ since: now, boxes }, ...rounds].slice(0, 2);
      const chosenBox = boxes.at(-1);
      return { x: chosenBox.x / width, y: chosenBox.y / height };
    },

    reset() {
      slots = new Array(count).fill(null);
      shownWeights = new Float32Array(count);
      rounds = [];
      chosenIndex = -1;
      boxedSlot = -1;
    },

    // No words for a while (the dark screen): the label boxes fade out as they do
    // between rounds, and the ring of words empties
    clear() {
      const now = performance.now();
      for (const round of rounds) round.endedAt ??= now;
      slots = new Array(count).fill(null);
      shownWeights = new Float32Array(count);
      chosenIndex = -1;
      boxedSlot = -1;
    },

    draw(now) {
      const density = canvas.width / width;
      ctx.setTransform(density, 0, 0, density, 0, 0);
      ctx.clearRect(0, 0, width, height);
      const t = now / 1000;
      const { short, radius, reach } = geometry();
      const centreX = width / 2;
      const centreY = height / 2;
      const ends = drawRing(now, t, centreX, centreY, radius, reach, short);

      // ---- The label boxes and their lines to words ----
      rounds = rounds.filter((round) => round.endedAt === undefined || now - round.endedAt < settings.labelFadeSeconds * 1000);
      for (let r = rounds.length - 1; r >= 0; r--) {
        const round = rounds[r];
        const fade = round.endedAt === undefined ? 1 : 1 - (now - round.endedAt) / (settings.labelFadeSeconds * 1000);
        const age = (now - round.since) / 1000;
        const current = r === 0; // only the newest round is gold and has lines; older ones just fade
        // Lines first, under every box
        const places = [];
        for (const box of round.boxes) {
          if (age < box.appearsAfter) continue;
          const place = boxFrame(box, box.x, box.y, width, height, t, fade);
          const misfit = soundCategory ? 1 - match(soundCategory, box.id) : 0;
          const slot = box.chosen ? boxedSlot : box.labelIndex >= 0 ? closestSlot(box.labelIndex) : -1;
          if (current && ends[slot]) drawLink(box, place, ends[slot], misfit, t);
          places.push([box, place, misfit]);
        }
        for (const [box, place, misfit] of places) {
          const gold = box.chosen && current;
          const colour = gold ? goldColour(place.opacity) : mismatchColour(misfit, place.opacity);
          // The same plain box as the sound screen (no backing, no corner marks: 2026-11-21)
          ctx.globalAlpha = 1;
          drawBox(ctx, box, place, colour, { glow: gold });
        }
      }
    },
  };

  // ---- The ring of words. Returns, for each slot, where a line should meet its word ----
  function drawRing(now, t, centreX, centreY, radius, reach, short) {
    // Weights relative to this round's chosen label: the heaviest word's ray is as
    // long as rayReach, the lightest a fifth of it. Rays ease to new lengths.
    const weights = slots.map((word, slot) => (word && chosenIndex >= 0 ? weightOf(slot, chosenIndex) : 0));
    const present = weights.filter((_, slot) => slots[slot]);
    const top = Math.max(...present, 0);
    const bottom = Math.min(...present, 0);
    const span = top - bottom || 1;
    const ends = [];

    ctx.save();
    ctx.translate(centreX, centreY);

    // A soft dark disc behind the whole ring, fading out at its edge
    const discRadius = radius + reach + WORD_FONT_PX * MAX_WORD_CHARS * 0.6;
    const disc = ctx.createRadialGradient(0, 0, radius * 0.4, 0, 0, discRadius);
    disc.addColorStop(0, "rgba(3, 6, 8, 0.55)");
    disc.addColorStop(0.75, "rgba(3, 6, 8, 0.35)");
    disc.addColorStop(1, "rgba(3, 6, 8, 0)");
    ctx.fillStyle = disc;
    ctx.beginPath();
    ctx.arc(0, 0, discRadius, 0, 2 * Math.PI);
    ctx.fill();

    // The circle, a fainter inner one, and a slowly turning dashed scale outside it
    ctx.strokeStyle = "#fff";
    ctx.lineWidth = 1;
    ctx.globalAlpha = 0.55;
    ctx.beginPath();
    ctx.arc(0, 0, radius, 0, 2 * Math.PI);
    ctx.stroke();
    ctx.globalAlpha = 0.18;
    ctx.beginPath();
    ctx.arc(0, 0, radius * 0.82, 0, 2 * Math.PI);
    ctx.stroke();
    ctx.save();
    ctx.rotate(t * 0.04);
    ctx.setLineDash([2, 6]);
    ctx.globalAlpha = 0.22;
    ctx.beginPath();
    ctx.arc(0, 0, radius + reach + 4, 0, 2 * Math.PI);
    ctx.stroke();
    ctx.restore();

    // The sweep: a short bright arc at the newest word, like a clock's hand
    const newest = slots.reduce((best, word, slot) => (word && (best < 0 || word.since > slots[best].since) ? slot : best), -1);
    if (newest >= 0) {
      const angle = angleOf(newest);
      ctx.globalAlpha = 0.8;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(0, 0, radius, angle - 0.12, angle + 0.12);
      ctx.stroke();
      ctx.lineWidth = 1;
    }

    const dt = Math.min(0.1, Math.max(0, (now - lastDraw) / 1000));
    lastDraw = now;
    for (let slot = 0; slot < count; slot++) {
      const word = slots[slot];
      const angle = angleOf(slot);
      const cos = Math.cos(angle);
      const sin = Math.sin(angle);
      // A small tick on the circle for every slot, filled or not
      ctx.strokeStyle = "#fff";
      ctx.globalAlpha = 0.35;
      ctx.beginPath();
      ctx.moveTo(cos * (radius - 5), sin * (radius - 5));
      ctx.lineTo(cos * radius, sin * radius);
      ctx.stroke();
      if (!word || now < word.since) continue;

      const relative = chosenIndex >= 0 ? (weights[slot] - bottom) / span : 0.5;
      shownWeights[slot] += (relative - shownWeights[slot]) * (1 - Math.exp(-dt / 0.25));
      const shownRelative = shownWeights[slot];
      const length = reach * mix(0.2, 1, shownRelative);
      const boxed = slot === boxedSlot;
      const fresh = Math.max(0, 1 - (now - word.since) / 1500); // 1 when it just arrived, fading
      const colour = boxed ? goldColour(1) : "#fff";

      // The ray
      ctx.strokeStyle = colour;
      ctx.globalAlpha = boxed ? 1 : mix(0.3, 0.85, shownRelative) + 0.15 * fresh;
      ctx.lineWidth = boxed ? 2 : 1;
      if (boxed) softGlow(ctx);
      ctx.beginPath();
      ctx.moveTo(cos * radius, sin * radius);
      ctx.lineTo(cos * (radius + length), sin * (radius + length));
      ctx.stroke();
      noGlow();

      // The word, written along its ray, from just past the ray's tip outwards.
      // On the left half, turned round so it reads left to right, not upside down.
      const start = radius + length + 6;
      const flip = cos < -1e-6;
      // The letters are drawn wider and flatter than the font (WORD_STRETCH, WORD_SQUASH)
      ctx.font = `${boxed ? "bold " : ""}${WORD_FONT_PX}px ${FONT}`;
      const textWidth = ctx.measureText(word.text).width * WORD_STRETCH;
      ctx.save();
      ctx.rotate(flip ? angle + Math.PI : angle);
      ctx.textBaseline = "middle";
      ctx.textAlign = flip ? "right" : "left";
      const textX = flip ? -start : start;
      ctx.globalAlpha = boxed ? 1 : Math.min(1, mix(0.78, 1, shownRelative) + 0.3 * fresh);
      ctx.fillStyle = fresh > 0.6 && !boxed ? "#fffbe8" : colour;
      ctx.save();
      ctx.translate(textX, 0);
      ctx.scale(WORD_STRETCH, WORD_SQUASH);
      ctx.fillText(word.text, 0, 0);
      ctx.restore();
      // Every word's HUD box, as visible as the word is meaningful (its weight for the
      // chosen label, relative to the other words on the ring). The heaviest is gold;
      // the rest white, mostly faint, each a little differently, and each round a few
      // words have none at all, whatever their weight (2026-11-21, see wordBoxAlpha).
      const boxAlpha = boxed ? 1 : wordBoxAlpha(shownRelative, boxLuck[slot]);
      if (boxAlpha > 0.01) {
        // On the same hard beat as the label boxes
        const beat = Math.floor(t * 6);
        const jitter = (n) => (hashFloat(slot * 13.1 + beat * 2.17 + n) - 0.5) * 3;
        const left = flip ? textX - textWidth : textX;
        const boxHeight = WORD_FONT_PX * WORD_SQUASH + 12;
        ctx.strokeStyle = boxed ? goldColour(1) : "#fff";
        ctx.lineWidth = boxed ? 1.6 : 1;
        ctx.globalAlpha = boxAlpha;
        if (boxed) softGlow(ctx);
        ctx.strokeRect(left - 6 + jitter(1), -boxHeight / 2 + jitter(2), textWidth + 12, boxHeight);
        noGlow();
      }
      ctx.restore();

      // Where a line meets this word: its outer end, the point farthest from the centre
      const end = start + textWidth + (boxed ? 8 : 3);
      ends[slot] = { x: centreX + cos * end, y: centreY + sin * end };
    }
    ctx.restore();
    return ends;
  }

  // A line from a label box to its word: from the box's edge to the word's outer end.
  // (No dark edge under it: removed 2026-11-21 at the user's request.)
  function drawLink(box, place, end, misfit, t) {
    const beat = Math.floor(t * LINK_BEATS_PER_SECOND + hashFloat(box.seed));
    const alpha = place.opacity * (box.chosen ? 1 : mix(0.65, 0.95, hashFloat(box.seed + beat * 3.73)));
    const from = boxEdge(place, end.x, end.y);
    const colour = (a) => (box.chosen ? goldColour(a) : mismatchColour(misfit, a));
    ctx.globalAlpha = 1;
    const gradient = ctx.createLinearGradient(from.x, from.y, end.x, end.y);
    gradient.addColorStop(0, colour(alpha));
    gradient.addColorStop(1, colour(alpha * (box.chosen ? 0.9 : 0.55)));
    ctx.strokeStyle = gradient;
    ctx.lineWidth = box.chosen ? 2.2 : 1.2;
    if (box.chosen) softGlow(ctx);
    ctx.beginPath();
    ctx.moveTo(from.x, from.y);
    ctx.lineTo(end.x, end.y);
    ctx.stroke();
    noGlow();
    // A small dot where it meets the word
    ctx.fillStyle = colour(alpha);
    ctx.beginPath();
    ctx.arc(end.x, end.y, box.chosen ? 2.6 : 1.6, 0, 2 * Math.PI);
    ctx.fill();
  }

  function noGlow() {
    ctx.shadowColor = "transparent";
    ctx.shadowBlur = 0;
  }
}

// A word's box opacity from its weight on the ring (0 = least meaningful word,
// 1 = most) and its luck this round (0–1, drawn anew each round):
//   · no box below wordBoxFrom, then rising slowly (cubed: most boxes stay faint,
//     only the strongest few are clearly visible) up to wordBoxMax
//   · the unluckiest wordBoxSkip of the words get no box this round, whatever their weight
//   · the rest are each scaled by their luck, so boxes of equal weight differ
function wordBoxAlpha(relative, luck) {
  const { wordBoxFrom, wordBoxMax, wordBoxSkip } = CONFIG.semanticScreen;
  if (relative <= wordBoxFrom || luck < wordBoxSkip) return 0;
  const t = (relative - wordBoxFrom) / (1 - wordBoxFrom);
  const variation = 0.35 + 0.65 * ((luck - wordBoxSkip) / (1 - wordBoxSkip));
  return wordBoxMax * t * t * t * variation;
}
