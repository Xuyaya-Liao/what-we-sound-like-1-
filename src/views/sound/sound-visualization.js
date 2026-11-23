// sound-visualization.js: the live input spectrum, drawn as a small ring of rays
// at the very centre of the sound screen, inside the CLAP vector ring
// (two-screen redesign). Lowest band at the top, rising clockwise; a ray's length is
// how loud that band is right now (the latest ~85 ms).
//
// The vector ring around it changes once a round (every 5 s); this one moves with
// every syllable, so the centre keeps breathing while the visitor speaks.
// sound-view.js owns the canvas and calls draw() each frame, already moved to the
// centre of the screen (ctx.translate), with the ring's size in pixels.

import { CONFIG } from "../../config.js";
import { createInputSpectrum } from "./input-spectrum.js";

const SEAM = Math.PI / 30; // Six degrees between the lowest and highest bands.
const START_ANGLE = -Math.PI / 2 + SEAM / 2;
const SWEEP = 2 * Math.PI - SEAM;

export function createSpectrumRing() {
  const settings = CONFIG.soundVisualization;
  const spectrum = createInputSpectrum(settings);
  const shown = new Float32Array(settings.bands);
  const rays = Array.from({ length: settings.bands }, (_, band) => {
    const step = SWEEP / settings.bands;
    const angle = START_ANGLE + (band + 0.5) * step;
    return [-0.3, 0, 0.3].map((offset, index) => {
      const direction = angle + offset * step;
      return {
        x: Math.cos(direction),
        y: Math.sin(direction),
        length: index === 1 ? 1 : 0.75 + random(band * 3 + index + 1) * 0.25,
        phase: random(band * 7 + index + 2),
      };
    });
  });
  let lastInput = -Infinity;
  let lastDraw = 0;

  return {
    reset() {
      spectrum.reset();
      shown.fill(0);
      lastInput = -Infinity;
    },
    push(samples, sampleRate) {
      spectrum.push(samples, sampleRate);
      lastInput = performance.now();
    },
    // radius: where the rays start; reach: how far the loudest band extends
    draw(ctx, now, radius, reach) {
      const dt = Math.min(0.1, Math.max(0, (now - lastDraw) / 1000));
      lastDraw = now;
      if (!Number.isFinite(lastInput)) return; // nothing heard yet: no ring at all

      const fresh = now - lastInput < 150;
      const attack = 1 - Math.exp(-dt / 0.035);
      const release = 1 - Math.exp(-dt / 0.12);
      const segment = (ray, from, to) => {
        ctx.moveTo(ray.x * from, ray.y * from);
        ctx.lineTo(ray.x * to, ray.y * to);
      };

      ctx.save();
      ctx.strokeStyle = "#fff";
      ctx.lineCap = "round";

      // A thin reference circle remains once capture has started, even in silence.
      ctx.lineWidth = 1;
      ctx.globalAlpha = 0.4;
      ctx.beginPath();
      ctx.arc(0, 0, radius, START_ANGLE, START_ANGLE + SWEEP);
      ctx.stroke();

      for (let i = 0; i < shown.length; i++) {
        const target = fresh ? spectrum.levels[i] : 0;
        shown[i] += (target - shown[i]) * (target > shown[i] ? attack : release);
        const amplitude = shown[i];
        if (amplitude < 0.015) continue;

        const extent = amplitude ** 1.35 * reach;
        ctx.globalAlpha = (0.22 + amplitude * 0.55) * Math.min(1, amplitude * 12);
        ctx.lineWidth = 1;
        ctx.beginPath();
        for (const ray of rays[i]) {
          const length = extent * ray.length;
          segment(ray, radius - length * 0.12, radius + length * 0.58);
          if (length > 3) {
            // The short fragments drift along their ray. Frequency position stays fixed.
            const phase = (ray.phase + now * 0.0008) % 1;
            const cursor = radius + length * (0.66 + phase * 0.24);
            segment(ray, cursor, cursor + Math.min(3.2, length * 0.1));
          }
        }
        ctx.stroke();
      }
      ctx.restore();
    },
  };
}

function random(seed) {
  const value = Math.sin(seed * 17.37) * 43758.5453;
  return value - Math.floor(value);
}
