// hud-kit.js: the HUD's shared look, used by both screens (two-screen redesign).
//
// Both screens draw "computer-vision debug" boxes and lines over what the machine
// compared (see DESIGN-two-screens.md): the semantic screen's words and labels
// (semantic/word-overlay.js) and the sound screen's candidate sounds (sound/sound-view.js).
// What they share lives here, so the two screens read as one visual language:
//   · boxes sized by their real weight, that jitter and flicker on a hard beat
//     (no easing between beats — a smooth version read as generic, feedback 2026-11-13)
//   · colour: white (mismatch 0) → a cool, alarmed red (mismatch 1) for everything,
//     except the one thing chosen this round, which is a saturated gold
//
// The red is kept on the cool (crimson) side on purpose, so that a half-mismatched
// pink-red can never be mistaken for the gold (decided 2026-11-20).

export const BOX_SCALE = 3.5;
export const BOX_BEATS_PER_SECOND = 6;
export const JITTER_PIXELS = 5;

// White at mismatch 0, crimson at 1
export function mismatchColour(mismatch, alpha) {
  const m = Math.min(1, Math.max(0, Number.isFinite(mismatch) ? mismatch : 0));
  const g = Math.round(255 - 215 * m);
  const b = Math.round(255 - 175 * m);
  return `rgba(255, ${g}, ${b}, ${alpha})`;
}

// The chosen one, on both screens (a touch lighter since 2026-11-21)
export function goldColour(alpha) {
  return `rgba(255, 210, 64, ${alpha})`;
}

// A faint gold halo for the chosen one's box and line: set it before stroking,
// and clear ctx.shadowBlur (or ctx.shadowColor) afterwards
export function softGlow(ctx) {
  ctx.shadowColor = goldColour(0.45);
  ctx.shadowBlur = 7;
}

// A box's size from its weight (0–1: a sound's chance of being drawn, a label's
// softmax share), so the likelier candidates are bigger. aspect varies per box.
export function boxSize(weight, chosen, seed) {
  const size = BOX_SCALE * (mix(9, 30, Math.min(1, weight * 1.6)) + (chosen ? 5 : 0));
  const aspect = Math.sqrt(mix(0.65, 2.2, hashFloat(seed * 3.71)));
  return { width: size * aspect, height: size / aspect };
}

// Where a box is drawn this frame: its place (x, y in pixels), nudged by a jitter
// and a size flicker that jump to new values on every beat. Kept inside the screen.
// box: { seed, width, height, opacity }; depth: dims an older round's boxes
export function boxFrame(box, x, y, width, height, t, depth = 1) {
  const beat = Math.floor(t * BOX_BEATS_PER_SECOND + hashFloat(box.seed));
  const seed = box.seed + beat * 2.17;
  const viewportScale = Math.min(1, width / 650, height / 450);
  const scale = viewportScale * mix(0.92, 1.08, hashFloat(seed));
  const boxWidth = box.width * scale;
  const boxHeight = box.height * scale;
  const jitterX = mix(-JITTER_PIXELS, JITTER_PIXELS, hashFloat(seed + 16.2));
  const jitterY = mix(-JITTER_PIXELS, JITTER_PIXELS, hashFloat(seed + 23.7));
  return {
    x: Math.max(boxWidth / 2 + 4, Math.min(width - boxWidth / 2 - 4, x + jitterX)),
    y: Math.max(boxHeight / 2 + 4, Math.min(height - boxHeight / 2 - 4, y + jitterY)),
    width: boxWidth,
    height: boxHeight,
    opacity: box.opacity * depth,
  };
}

// A box's border and its text. stroke: the border colour (with alpha already in it).
// box.label: the first line; box.sublabel (optional): a second, quieter line.
// glow: a faint gold halo round the border (the chosen one)
export function drawBox(ctx, box, { x, y, width, height, opacity }, stroke, { glow = false } = {}) {
  const left = x - width / 2;
  const top = y - height / 2;
  ctx.strokeStyle = stroke;
  ctx.lineWidth = box.chosen ? 2.2 : 1.5;
  if (glow) softGlow(ctx);
  ctx.strokeRect(left, top, width, height);
  ctx.shadowBlur = 0;

  ctx.font = `${box.chosen ? 12 : 11}px "Courier New", monospace`;
  ctx.textBaseline = "top";
  ctx.textAlign = "left";
  ctx.fillStyle = `rgba(244, 247, 246, ${opacity})`;
  ctx.fillText(box.label, left + 4, top + 4);
  if (box.sublabel) {
    ctx.font = '10px "Courier New", monospace';
    ctx.fillStyle = `rgba(244, 247, 246, ${opacity * 0.6})`;
    ctx.fillText(box.sublabel, left + 4, top + 18);
  }
}

// The point on a box's border in the direction of (towardX, towardY), so a line can
// start or end there instead of crossing the box's text.
// place: { x, y, width, height } (centre and size, as from boxFrame)
export function boxEdge(place, towardX, towardY) {
  const dx = towardX - place.x;
  const dy = towardY - place.y;
  const t = Math.min(
    Math.abs(dx) > 1e-6 ? place.width / 2 / Math.abs(dx) : Infinity,
    Math.abs(dy) > 1e-6 ? place.height / 2 / Math.abs(dy) : Infinity,
    1,
  );
  return { x: place.x + dx * t, y: place.y + dy * t };
}

export function mix(a, b, t) {
  return a + (b - a) * t;
}

// Turns a number into another 0–1 pseudo-random number, stable for the same
// input — used for everything from "where is this box" to "is this link lit
// up this beat". Safe to use freely here (unlike in the GLSL shaders): this
// runs in JavaScript's doubles, not GPU floats, so it doesn't show the
// precision artifacts the same formula caused in image.frag.
export function hashFloat(n) {
  const x = Math.sin(n) * 43758.5453123;
  return x - Math.floor(x);
}

// Turns an id (e.g. "geothermal") into a small, stable number to seed hashFloat with.
export function hashSeed(id) {
  let hash = 0;
  for (let i = 0; i < id.length; i++) hash = (hash * 31 + id.charCodeAt(i)) % 100000;
  return hash;
}
