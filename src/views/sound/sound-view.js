// sound-view.js: the sound screen, "how we say it" (step 2 of DESIGN-two-screens.md).
//
// On black, no image. From the centre outwards:
//   · the live input spectrum, a small ring that moves with every syllable
//     (sound-visualization.js)
//   · the CLAP vector of the voice, a ring of 512 rays that reshapes once a round
//     (vector-ring.js)
//   · the candidate sounds the sound choice ranked this round, as HUD boxes
//     (src/sound/sound-choice.js: the closest 15; 5 of them could be drawn)
//
// Where a candidate box sits means something:
//   · its DIRECTION is its sound category's: every category has a fixed slice of the
//     circle (the order of config/sound-categories.json, clockwise from the top), so
//     over a visit "rain lives up and to the right"
//   · its DISTANCE is how similar it is: the round's most similar candidate sits
//     right by the ring, the least similar farthest out
//   · its SIZE is its chance of being drawn (0 for the 10 that could not be)
// Every box has a line to the centre, fading to nothing towards it. The sound that was
// actually drawn — the one now playing — is gold, box and line, and its box shows
// that sound live: its waveform and spectrum (createPlaybackScope, below). Every other box and
// line is white → red by how badly its category fits the image on the semantic screen
// right now (the same match table as mismatch), so the red ones are sounds that would
// have clashed with the picture.
//
// It lives in the engine's own page (index.html), because the spectrum needs the raw
// microphone samples, ~25 batches a second — too much to send to another window.
// Everything else arrives through the bus (src/shared/bus.js), so ?replay= works too.
//
// container: the element to draw in. bus: see src/shared/bus.js.
// Returns { pushAudio(samples, sampleRate) } for the microphone's samples.

import { CONFIG } from "../../config.js";
import { loadSoundCategories } from "../../library.js";
import { createMatchLookup } from "../../shared/match.js";
import { boxEdge, boxFrame, boxSize, drawBox, goldColour, hashFloat, hashSeed, mismatchColour, mix, softGlow } from "../hud-kit.js";
import { createSpectrumRing } from "./sound-visualization.js";
import { createVectorRing, loadRingLayout } from "./vector-ring.js";

const LINK_BEATS_PER_SECOND = 4;
const MARGIN = 0.07; // keep box centres this far (fraction of the shorter side) from the screen's edges

export function createSoundView(container, bus) {
  const settings = CONFIG.soundScreen;
  const canvas = document.createElement("canvas");
  canvas.className = "screen-canvas";
  container.append(canvas);
  const ctx = canvas.getContext("2d");
  let width = 1;
  let height = 1;

  const spectrum = createSpectrumRing();
  let ring; // the vector ring, once its layout (data/vector-ring.json) is loaded
  let pendingVector; // a vector that arrived before the layout did
  loadRingLayout()
    .then((layout) => {
      ring = createVectorRing(layout);
      if (pendingVector) ring.setVector(pendingVector);
    })
    .catch((error) => console.error(error)); // the screen still works, without the ring

  // Category → its direction (radians, clockwise from the top)
  const categoryAngle = new Map();
  loadSoundCategories()
    .then((categories) =>
      categories.forEach(({ id }, i) => categoryAngle.set(id, -Math.PI / 2 + (2 * Math.PI * (i + 0.5)) / categories.length)),
    )
    .catch((error) => console.error(error));
  const angleOf = (category) => categoryAngle.get(category) ?? -Math.PI / 2 + hashFloat(hashSeed(category)) * 2 * Math.PI;

  let match = () => 0.5;
  let label; // the image label on the semantic screen right now, to colour against
  let rounds = []; // newest first: { since, endedAt?, boxes }
  let playing; // { id, analyser }: the sound now playing, for its box (see setPlaying)
  const playback = createPlaybackScope();

  bus.on("matchTable", (table) => (match = createMatchLookup(table)));
  bus.on("image", (image) => (label = image.label));
  bus.on("mismatch", (data) => (label = data.label ?? label));
  bus.on("sound", (data) => addRound(data));
  bus.on("reset", () => {
    spectrum.reset();
    ring?.reset();
    pendingVector = undefined;
    rounds = [];
    label = undefined;
    playing = undefined;
  });
  bus.on("end", () => spectrum.reset());
  // No words for a while: the boxes and lines fade out, the ring shrinks back into
  // its bare circle. (The small spectrum ring in the middle keeps listening.)
  bus.on("dark", () => {
    const now = performance.now();
    for (const round of rounds) round.endedAt ??= now;
    ring?.release();
    pendingVector = undefined;
    playing = undefined;
    label = undefined;
  });

  // ---- A round: where each candidate goes ----
  function addRound({ candidates = [], chosen, vector }) {
    if (ring) ring.setVector(vector);
    else pendingVector = vector;
    if (!candidates.length) return;

    const now = performance.now();
    for (const round of rounds) round.endedAt ??= now;

    // Similarity → distance: the best candidate 0 (by the ring), the worst 1
    const scores = candidates.map((candidate) => candidate.score);
    const best = Math.max(...scores);
    const worst = Math.min(...scores);
    const spread = best - worst || 1;
    const sector = (2 * Math.PI) / Math.max(1, categoryAngle.size || 18);

    const boxes = candidates.map((candidate, rank) => {
      const isChosen = candidate.id === chosen?.id;
      const seed = hashSeed(candidate.id);
      const size = boxSize(candidate.weight, isChosen, seed);
      return {
        // The playing box is at least big enough to show the sound inside it
        width: isChosen ? Math.max(size.width, settings.playingBoxWidth) : size.width,
        height: isChosen ? Math.max(size.height, settings.playingBoxHeight) : size.height,
        id: candidate.id,
        category: candidate.category,
        chosen: isChosen,
        seed,
        // Spread clips of the same category across their slice, so they don't stack
        angle: angleOf(candidate.category) + (hashFloat(seed + 5.1) - 0.5) * sector * 0.75,
        distance: (best - candidate.score) / spread,
        opacity: isChosen ? 1 : mix(0.5, 0.9, 1 - rank / Math.max(1, candidates.length - 1)),
        // The others appear one by one; the chosen one last, like a decision being made
        appearsAfter: isChosen ? settings.maxEntryDelay : hashFloat(seed + 31.7) * settings.maxEntryDelay * 0.8,
        label: `${candidate.category} ${candidate.score.toFixed(2)}`,
        sublabel: isChosen ? shorten(candidate.title, 28) : undefined,
        readout: `score ${candidate.score.toFixed(3)} · p ${Math.round(candidate.weight * 100)}%`,
      };
    });
    // Draw the chosen one last, so it sits on top
    boxes.sort((a, b) => a.chosen - b.chosen);
    rounds = [{ since: now, boxes }, ...rounds].slice(0, 2);
  }

  // ---- Every frame ----
  function resize() {
    width = Math.max(1, container.clientWidth);
    height = Math.max(1, container.clientHeight);
    const density = Math.min(2, window.devicePixelRatio || 1);
    canvas.width = Math.round(width * density);
    canvas.height = Math.round(height * density);
    ctx.setTransform(density, 0, 0, density, 0, 0); // draw in CSS pixels from here on
  }
  new ResizeObserver(resize).observe(container); // also covers the window being resized
  resize();

  function frame(now) {
    const density = canvas.width / width;
    ctx.setTransform(density, 0, 0, density, 0, 0);
    ctx.clearRect(0, 0, width, height);

    const short = Math.min(width, height);
    const centreX = width / 2;
    const centreY = height / 2;

    ctx.save();
    ctx.translate(centreX, centreY);
    const sv = CONFIG.soundVisualization;
    spectrum.draw(ctx, now, short * sv.radius, short * sv.radialReach);
    ring?.draw(ctx, now, short * settings.ringRadius, short * settings.rayReach);
    ctx.restore();

    // Candidates: from just outside the ring's usual edge out to the screen's edges.
    // (A rare long spike may reach under the nearest boxes; that is fine.)
    const nearest = short * (settings.ringRadius + settings.rayReach * 0.9 + settings.nearest);
    const farX = Math.max(nearest, width / 2 - short * MARGIN);
    const farY = Math.max(nearest, height / 2 - short * MARGIN);
    const t = now / 1000;
    rounds = rounds.filter((round) => round.endedAt === undefined || now - round.endedAt < settings.roundFadeSeconds * 1000);
    for (let i = rounds.length - 1; i >= 0; i--) {
      const round = rounds[i];
      const fade = round.endedAt === undefined ? 1 : 1 - (now - round.endedAt) / (settings.roundFadeSeconds * 1000);
      const age = (now - round.since) / 1000;
      for (const box of round.boxes) {
        if (age < box.appearsAfter) continue;
        // An ellipse rather than a circle, so a wide screen is used edge to edge
        const reach = (far) => mix(nearest, far, box.distance);
        const x = centreX + Math.cos(box.angle) * reach(farX);
        const y = centreY + Math.sin(box.angle) * reach(farY);
        const place = boxFrame(box, x, y, width, height, t, fade);
        const colour = box.chosen ? goldColour(place.opacity) : mismatchColour(mismatchOf(box), place.opacity);
        drawLink(box, place, centreX, centreY, short, t);
        if (box.chosen) {
          // A dark inside, so the sound's picture reads over the lines behind it
          ctx.fillStyle = `rgba(0, 0, 0, ${0.75 * place.opacity})`;
          ctx.fillRect(place.x - place.width / 2, place.y - place.height / 2, place.width, place.height);
          playback.draw(ctx, place, box.id === playing?.id ? playing.analyser : undefined);
        }
        drawBox(ctx, box, place, colour, { glow: box.chosen });
      }
    }
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);

  // How badly this candidate's category fits the image on screen now (white if no image yet)
  function mismatchOf(box) {
    return label ? 1 - match(box.category, label) : 0;
  }

  // A line from the centre to the box: invisible at the centre, full strength at the
  // box. Starts at the spectrum ring's edge, so the very centre stays clear.
  function drawLink(box, place, centreX, centreY, short, t) {
    const beat = Math.floor(t * LINK_BEATS_PER_SECOND + hashFloat(box.seed));
    const pulse = box.chosen ? 1 : mix(0.55, 0.95, hashFloat(box.seed + beat * 3.73));
    const alpha = place.opacity * pulse;
    const colour = (a) => (box.chosen ? goldColour(a) : mismatchColour(mismatchOf(box), a));
    const startRadius = short * CONFIG.soundVisualization.radius;
    const dx = place.x - centreX;
    const dy = place.y - centreY;
    const length = Math.hypot(dx, dy) || 1;
    // End at the box's edge, not its centre, so the line never crosses its text
    const { x: endX, y: endY } = boxEdge(place, centreX, centreY);

    const gradient = ctx.createLinearGradient(centreX, centreY, endX, endY);
    gradient.addColorStop(0, colour(0));
    gradient.addColorStop(0.35, colour(alpha * 0.15));
    gradient.addColorStop(1, colour(alpha));
    ctx.strokeStyle = gradient;
    ctx.lineWidth = box.chosen ? 2.4 : 1.1;
    if (box.chosen) softGlow(ctx);
    ctx.beginPath();
    ctx.moveTo(centreX + (dx / length) * startRadius, centreY + (dy / length) * startRadius);
    ctx.lineTo(endX, endY);
    ctx.stroke();
    ctx.shadowBlur = 0;

    if (box.chosen) {
      // The numbers behind the choice, just under the gold box
      ctx.font = '11px "Courier New", monospace';
      ctx.textAlign = "left";
      ctx.textBaseline = "top";
      ctx.fillStyle = goldColour(alpha);
      ctx.fillText(box.readout, place.x - place.width / 2, place.y + place.height / 2 + 4);
    }
  }

  return {
    pushAudio: (samples, sampleRate) => spectrum.push(samples, sampleRate),
    // The sound with this id has started playing; analyser listens to it alone
    // (src/audio/player.js). Its box shows it until the next sound is chosen.
    setPlaying(id, analyser) {
      if (analyser) playing = { id, analyser };
    },
  };
}

// The picture of the playing sound, inside its box: its spectrum as bars mirrored
// above and below the middle (low notes on the left, high on the right, spaced like
// the ear hears them), and its waveform across them as a bright line. The waveform
// is scaled to the sound's own level, so a quiet clip still shows its shape; the
// bars are not, so a fade-in or fade-out shows as the bars growing or shrinking.
// With no analyser (a replay, or before the sound has started): a flat line.
function createPlaybackScope() {
  const MIN_HZ = 60;
  const MAX_HZ = 12000;
  const FLOOR_DB = -100;
  const CEILING_DB = -30;
  let wave;
  let spectrum;
  let peak = 0.05; // the waveform's recent peak, for its scale; follows the sound slowly

  return {
    draw(ctx, place, analyser) {
      const left = place.x - place.width / 2 + 8;
      const right = place.x + place.width / 2 - 8;
      const top = place.y - place.height / 2 + 32; // below the box's two lines of text
      const bottom = place.y + place.height / 2 - 6;
      if (bottom - top < 12 || right - left < 20) return;
      const middle = (top + bottom) / 2;
      const half = (bottom - top) / 2;
      const alpha = place.opacity;

      ctx.save();
      ctx.lineCap = "round";
      if (!analyser) {
        ctx.strokeStyle = goldColour(0.4 * alpha);
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(left, middle);
        ctx.lineTo(right, middle);
        ctx.stroke();
        ctx.restore();
        return;
      }

      // The spectrum: one bar every 3 px, log-spaced in frequency
      if (spectrum?.length !== analyser.frequencyBinCount) spectrum = new Float32Array(analyser.frequencyBinCount);
      analyser.getFloatFrequencyData(spectrum);
      const binHz = analyser.context.sampleRate / analyser.fftSize;
      const bars = Math.floor((right - left) / 3);
      ctx.strokeStyle = goldColour(0.45 * alpha);
      ctx.lineWidth = 1.6;
      ctx.beginPath();
      for (let i = 0; i < bars; i++) {
        const lowHz = MIN_HZ * (MAX_HZ / MIN_HZ) ** (i / bars);
        const highHz = MIN_HZ * (MAX_HZ / MIN_HZ) ** ((i + 1) / bars);
        let db = -Infinity;
        for (let bin = Math.floor(lowHz / binHz); bin <= Math.ceil(highHz / binHz) && bin < spectrum.length; bin++) {
          db = Math.max(db, spectrum[bin]);
        }
        const level = Math.max(0, Math.min(1, (db - FLOOR_DB) / (CEILING_DB - FLOOR_DB)));
        if (level < 0.02) continue;
        const x = left + (i + 0.5) * ((right - left) / bars);
        const h = level * half;
        ctx.moveTo(x, middle - h);
        ctx.lineTo(x, middle + h);
      }
      ctx.stroke();

      // The waveform: the latest ~40 ms, across the whole width
      if (wave?.length !== analyser.fftSize) wave = new Float32Array(analyser.fftSize);
      analyser.getFloatTimeDomainData(wave);
      let loudest = 0;
      for (const sample of wave) loudest = Math.max(loudest, Math.abs(sample));
      peak += (Math.max(0.02, loudest) - peak) * (loudest > peak ? 0.3 : 0.03);
      const samples = Math.min(wave.length, 1024);
      ctx.strokeStyle = goldColour(alpha);
      ctx.lineWidth = 1.3;
      ctx.shadowColor = goldColour(0.8);
      ctx.shadowBlur = 6;
      ctx.beginPath();
      for (let i = 0; i < samples; i++) {
        const x = left + (i / (samples - 1)) * (right - left);
        const y = middle - Math.max(-1, Math.min(1, wave[i] / peak)) * half * 0.9;
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.stroke();
      ctx.restore();
    },
  };
}

function shorten(text = "", length) {
  const plain = text.replace(/\.(wav|ogg|mp3|flac)$/i, "");
  return plain.length > length ? `${plain.slice(0, length - 1)}…` : plain;
}
