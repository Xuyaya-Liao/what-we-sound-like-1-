// vector-ring.js: the CLAP vector of the visitor's voice, drawn as a ring of 512
// rays at the centre of the sound screen (step 2 of DESIGN-two-screens.md).
//
// Every round, CLAP turns 5 seconds of the voice into 512 numbers, and the sound
// choice compares that vector with every nature sound (src/sound/sound-choice.js).
// This ring is that exact vector — the centered one, when centering is on, so it
// shows how this voice differs from an average voice, which is what was compared:
//   · one ray per dimension, all the way round
//   · a ray points OUT where this voice is higher than usual on that dimension,
//     IN where it is lower; its length is how unusual (in "usual amounts")
//   · the dimensions are in the order of data/vector-ring.json, which puts
//     dimensions that rise and fall together side by side (npm run build:ring), so
//     the ring comes out as a few broad bulges and dents rather than random fuzz
//
// A new round's vector doesn't replace the old one in a single frame: every ray
// glides from where it is to its new length over morphSeconds (about a whole round),
// easing in and out, and the ring glows a little as it does. So the ring is almost
// always on its way from one voice's shape to the next. Faint outlines of the last
// few rounds' shapes stay behind it (ghosts), so a change of voice — whispering,
// then shouting — shows as the shape moving away from where it was.
//
// On top of the real shape, a slow undulation keeps it alive even when no new
// vector comes (a quiet room): a few broad waves travel round the ring, each at its
// own slow speed (driftAmount, driftSeconds). It is decoration, kept small next to
// the real shape; set driftAmount to 0 to see the vector alone.
// (2026-11-21: the first version snapped to each new shape in about a second, then
// sat still until the next round.)
//
// Each ray also "breathes": its brightness rises and falls on its own slow cycle,
// with its own length and starting point, so neighbouring rays are always out of
// step and the ring shimmers even between rounds. Only the brightness breathes, not
// the length: the shape itself is always the real vector.
//
// The ring's size never follows the voice's loudness (it did until 2026-11-21; it
// read as the ring jittering with every syllable). The small spectrum ring inside it
// (sound-visualization.js) is what moves with the voice.
//
// draw() is called by sound-view.js each frame, already moved to the screen's centre.

import { CONFIG } from "../../config.js";

const RING_FILE = "./data/vector-ring.json";
const USUAL_AMOUNTS = 2.4; // a ray this many "usual amounts" from average reaches rayReach
const OUTWARD_CAP = 1.4; // longest outward ray, in rayReach (one extreme dimension can't spike across the screen)
const INWARD_CAP = 0.65; // longest inward ray: stops short of the spectrum ring inside
// The undulation: waves with this many bulges round the ring, each travelling at
// its own speed (a fraction of driftSeconds per cycle) and with its own weight
const DRIFT_WAVES = [
  { bulges: 2, speed: 1, weight: 0.45 },
  { bulges: 3, speed: -0.7, weight: 0.35 },
  { bulges: 5, speed: 1.6, weight: 0.2 },
];

export async function loadRingLayout() {
  const response = await fetch(RING_FILE, { cache: "no-cache" });
  if (!response.ok) throw new Error(`Could not load ${RING_FILE} (HTTP ${response.status}). Run npm run build:ring.`);
  return response.json();
}

// layout: { order, scale } from data/vector-ring.json
export function createVectorRing(layout) {
  const settings = CONFIG.soundScreen;
  const { order, scale } = layout;
  const count = order.length;
  const angles = Float32Array.from({ length: count }, (_, k) => -Math.PI / 2 + (2 * Math.PI * k) / count);
  const cos = angles.map(Math.cos);
  const sin = angles.map(Math.sin);
  // Each ray's breathing: its own cycle length (breathMinSeconds … breathMaxSeconds)
  // and its own starting point in that cycle
  const breathSpeed = Float32Array.from(
    { length: count },
    (_, k) => (2 * Math.PI) / (settings.breathMinSeconds + random(k * 3.71 + 1) * (settings.breathMaxSeconds - settings.breathMinSeconds)),
  );
  const breathPhase = Float32Array.from({ length: count }, (_, k) => random(k * 7.13 + 2) * 2 * Math.PI);

  const target = new Float32Array(count); // where each ray is heading
  const shown = new Float32Array(count); // where each ray is now (without the undulation)
  const from = new Float32Array(count); // where each ray was when the current morph began
  const smoothFrom = new Float32Array(count);
  const drift = new Float32Array(count); // the undulation, this frame
  const wavePhase = DRIFT_WAVES.map((_, i) => random(i * 5.3 + 9) * 2 * Math.PI);
  // The same, averaged with its neighbours around the ring: the broad shape. Even in
  // the reordered layout, neighbouring dimensions only partly agree (correlation
  // ~0.5, see build-ring-order.mjs), so the raw rays alone still read as fuzz
  // (checked on real voices, 2026-11-20). The rays stay raw; the bright outline and
  // the ghosts follow this smoothed shape, which is what the eye can follow.
  const smoothTarget = new Float32Array(count);
  const smoothShown = new Float32Array(count);
  let ghosts = []; // the last rounds' smoothed shapes, newest first
  let has = false; // a vector has arrived
  let arrivedAt = -Infinity; // when the latest one did: its morph starts then
  // 1 while there is a voice to show; fades to 0 after release() (no words: the dark
  // screen), taking the rays, outline and undulation with it, back to the bare circle
  let presence = 0;
  let presenceTarget = 0;
  let lastDraw = 0;

  const cap = (value) => Math.max(-INWARD_CAP, Math.min(OUTWARD_CAP, value));

  return {
    // vector: the 512 numbers the sounds were compared with (in CLAP's own order)
    setVector(vector) {
      if (!vector || vector.length !== count) return;
      if (has) ghosts = [Float32Array.from(smoothTarget), ...ghosts].slice(0, settings.ghosts);
      // The next morph starts from wherever the ring is now, even mid-way through the last
      from.set(shown);
      smoothFrom.set(smoothShown);
      // Each dimension relative to how much it usually varies, then capped
      for (let k = 0; k < count; k++) {
        const dim = order[k];
        target[k] = cap(vector[dim] / scale[dim] / USUAL_AMOUNTS);
      }
      // The broad shape: a moving average around the ring (it wraps), then stretched
      // so its bulges are as big as the raw rays' typical size
      const half = settings.smoothRays;
      let rawSpread = 0;
      let smoothSpread = 0;
      for (let k = 0; k < count; k++) {
        let sum = 0;
        for (let d = -half; d <= half; d++) sum += target[(k + d + count) % count];
        smoothTarget[k] = sum / (2 * half + 1);
        rawSpread += target[k] ** 2;
        smoothSpread += smoothTarget[k] ** 2;
      }
      const stretch = Math.sqrt(rawSpread / Math.max(1e-9, smoothSpread));
      for (let k = 0; k < count; k++) smoothTarget[k] = cap(smoothTarget[k] * stretch);
      has = true;
      arrivedAt = performance.now();
      presenceTarget = 1;
    },

    // No words for a while: the ring fades back to its bare circle
    release() {
      presenceTarget = 0;
      ghosts = [];
    },

    reset() {
      target.fill(0);
      shown.fill(0);
      from.fill(0);
      smoothFrom.fill(0);
      smoothTarget.fill(0);
      smoothShown.fill(0);
      ghosts = [];
      has = false;
      presence = 0;
      presenceTarget = 0;
    },

    // radius, reach: in pixels. Returns the ring's outer edge (radius + its longest
    // outward ray), so the candidate boxes can keep clear of it.
    draw(ctx, now, radius, reach) {
      // The morph: from the old shape to the new over morphSeconds, easing in and out
      const progress = Math.min(1, Math.max(0, (now - arrivedAt) / (settings.morphSeconds * 1000)));
      const eased = progress * progress * (3 - 2 * progress);
      for (let k = 0; k < count; k++) {
        shown[k] = from[k] + (target[k] - from[k]) * eased;
        smoothShown[k] = smoothFrom[k] + (smoothTarget[k] - smoothFrom[k]) * eased;
      }
      const t = now / 1000;
      // A gentle glow while the shape is changing, strongest half-way through
      const flare = Math.sin(Math.PI * progress) * 0.6;
      // Presence glides in and out over about 1.5 s
      const dt = Math.min(0.1, Math.max(0, (now - lastDraw) / 1000));
      lastDraw = now;
      presence += (presenceTarget - presence) * (1 - Math.exp(-dt / 0.5));
      // How far the shape is drawn out from the circle: the whole shape shrinks back
      // into it as presence fades
      const shapeReach = reach * presence;

      // The undulation: a few broad waves travelling slowly round the ring
      const cycle = (2 * Math.PI * t) / settings.driftSeconds;
      for (let k = 0; k < count; k++) {
        let sum = 0;
        DRIFT_WAVES.forEach(({ bulges, speed, weight }, i) => {
          sum += weight * Math.sin(bulges * angles[k] + cycle * speed + wavePhase[i]);
        });
        drift[k] = sum * settings.driftAmount;
      }

      ctx.save();
      ctx.lineCap = "round";

      // The base circle; before the first round it is all there is
      ctx.strokeStyle = "#fff";
      ctx.globalAlpha = 0.3 - 0.1 * presence;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.arc(0, 0, radius, 0, 2 * Math.PI);
      ctx.stroke();
      if (!has || presence < 0.01) {
        ctx.restore();
        return radius;
      }

      // The ghosts: older shapes as thin outlines, fainter the older they are
      ctx.lineWidth = 1;
      ghosts.forEach((ghost, i) => {
        ctx.globalAlpha = (0.3 / (i + 1)) * presence;
        outline(ctx, ghost, radius, shapeReach);
        ctx.stroke();
      });

      // The rays: one per dimension, the raw values. Outward rays are brighter than
      // inward ones; each breathes on its own cycle; all glow a little while morphing.
      let outer = radius;
      ctx.lineWidth = 1.1;
      for (let k = 0; k < count; k++) {
        const value = shown[k];
        const tip = radius + (value + drift[k]) * shapeReach;
        if (tip > outer) outer = tip;
        const strength = value > 0 ? 0.3 + 0.6 * Math.min(1, value) : 0.2 + 0.35 * Math.min(1, -value);
        const breath = 0.5 + 0.5 * Math.sin(t * breathSpeed[k] + breathPhase[k]); // 0 … 1
        const breathing = 1 - settings.breathDepth + settings.breathDepth * breath;
        ctx.globalAlpha = Math.min(1, strength * breathing + 0.35 * flare) * presence;
        ctx.beginPath();
        ctx.moveTo(cos[k] * radius, sin[k] * radius);
        ctx.lineTo(cos[k] * tip, sin[k] * tip);
        ctx.stroke();
      }

      // The broad shape, bright: a soft filled band between the circle and the
      // smoothed outline, then the outline itself
      ctx.fillStyle = "#fff";
      ctx.globalAlpha = (0.06 + 0.06 * flare) * presence;
      outline(ctx, smoothShown, radius, shapeReach);
      ctx.arc(0, 0, radius, 0, 2 * Math.PI, true);
      ctx.fill("evenodd");
      ctx.globalAlpha = 0.85 * presence;
      ctx.lineWidth = 1.4 + 1.2 * flare;
      ctx.shadowColor = "rgba(255, 255, 255, 0.8)";
      ctx.shadowBlur = 4 + 10 * flare;
      outline(ctx, smoothShown, radius, shapeReach);
      ctx.stroke();
      for (let k = 0; k < count; k++) outer = Math.max(outer, radius + (smoothShown[k] + drift[k]) * shapeReach);
      ctx.restore();
      return outer;

      // Every outline (current and ghosts) carries the same undulation, so they move together
      function outline(context, values, base, length) {
        context.beginPath();
        for (let k = 0; k <= count; k++) {
          const i = k % count;
          const tip = base + (values[i] + drift[i]) * length;
          if (k === 0) context.moveTo(cos[i] * tip, sin[i] * tip);
          else context.lineTo(cos[i] * tip, sin[i] * tip);
        }
      }
    },
  };
}

// A stable 0–1 pseudo-random number for a seed
function random(seed) {
  const value = Math.sin(seed * 12.9898) * 43758.5453;
  return value - Math.floor(value);
}
