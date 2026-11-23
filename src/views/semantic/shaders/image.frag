// image.frag — visuals v2 (step 10). Every pixel's colour is decided here, driven
// mainly by ONE number: mismatch, how well the chosen sound's category and the
// chosen image's label agree (0 = they agree, 1 = they don't — see main.js's
// showImage() and src/workers/speech-worker.js's buildMatchMatrix). Every number
// below is set from CONFIG.visuals in config.js.
//
// This shader was designed and tuned in a separate tool first, with sliders
// instead of real sound/image data: experiments/visuals-lab/. Tune there, copy
// the numbers into config.js's visuals section, keep both files in step. If you
// want a different look altogether, this file (and its sibling, image.vert) are
// where to start: main.js only ever calls createVisuals() and showPicture(file).
//
// Confirmed design rules (decided 2026-11-13):
//   · colour and the liquid warp are driven ONLY by mismatch, never by the voice's
//     volume
//   · the voice's volume (uEnergy) gets a LIGHT, secondary role only: a touch more
//     jitter, a touch more brightness — nothing structural, no colour, no warp
//   · mismatch applies continuously, for as long as an image is shown — not just
//     during the moment of switching to it
//   · low mismatch: the image's own real colour, a fine clean scanline texture,
//     almost no warp or jitter — orderly
//   · high mismatch: chromatic aberration, colour pushed toward inverted/high-
//     saturation, the image broken into jittering, glitching grid cells, a strong
//     liquid warp — psychedelic, glitchy
//   · switching images is a grid-cell dissolve (not a true particle system): cells
//     reveal in a scattered order, more scattered the more mismatched the new
//     pairing is
//
// Revised 2026-11-13 after the first real test, which read as too busy to make
// out the image at all almost all the time:
//   · mismatch is now a PERCENTILE RANK (buildMatchMatrix), not a min–max scale:
//     the raw similarities turned out to cluster narrowly, so min–max left nearly
//     every real pairing reading as "fairly mismatched". Ranking spreads them
//     evenly across 0–1, so a typically good pairing now reads as calm.
//   · a new "activity" number (uActivity, from visuals.js) is 1 while a switch is
//     under way and eases down to a calmer baseline once the image has settled,
//     so the busiest effects are concentrated at the moment of change and a
//     visitor gets a proper, readable look at each image in between
//   · the glitch is small rectangular patches scattered over the image now, not a
//     full-width band shifting sideways (that read as the whole picture sliding)
//   · the dissolve uses its own small, fixed grid (uDissolveGrid), not scaled by
//     mismatch, so even a very mismatched new image arrives in small, quick
//     pieces rather than big slow ones
//
// GLSL basics: every value has a type (float, vec2/3/4 = 2/3/4 numbers together —
// a position, a colour…); there is no "last frame" — every pixel is computed from
// scratch, every time, from the uniforms below (set from visuals.js) and its own
// position (vTexCoord, (0,0) top-left … (1,1) bottom-right).

precision highp float;

varying vec2 vTexCoord;

// ---- The two images: current = the one now shown; previous = the one before it.
// "Has" is 0 before any image has loaded. ----
uniform sampler2D uCurrent;
uniform sampler2D uPrevious;
uniform vec2 uCurrentSize;
uniform vec2 uPreviousSize;
uniform float uHasCurrent;
uniform float uHasPrevious;
uniform float uCurrentZoom;
uniform float uPreviousZoom;

uniform vec2 uResolution;
uniform float uTime;        // seconds
uniform float uTransition;  // 0 = just switched … 1 = fully switched over

// ---- The numbers that drive almost everything ----
uniform float uMismatch;      // mismatch right now, 0–1, already eased (semantic-view.js)
uniform float uEnergy;        // the voice's volume, 0–1 — a light, secondary role only
uniform float uActivity;      // 1 while a switch is under way, easing down to a calmer
                               // baseline once the image has settled (see visuals.js) —
                               // so a visitor gets a real, readable look at each image

// ---- CONFIG.visuals: the maximum strength of each effect, reached at mismatch = 1 ----
uniform float uWarpAmount;
uniform float uAberrationAmount;
uniform float uInvertAmount;
uniform float uSaturateAmount;
uniform float uGlitchAmount;
uniform float uJitterAmount;
uniform float uScanlineAmount;
uniform float uGridFine;      // grid cell size in pixels when mismatch = 0 (small = fine)
uniform float uGridCoarse;    // grid cell size in pixels when mismatch = 1 (large = chunky)
uniform vec2 uOrigin;         // where a new image spreads out from, 0–1 (top-left = 0, 0)
uniform float uSpreadRoughness; // how ragged the spreading edge is (more with mismatch)
uniform float uDissolveGrid;  // the dissolve's OWN cell size in pixels, fixed — not scaled
                               // by mismatch, so a new image always arrives in small,
                               // quick pieces rather than big slow blocks
uniform float uEnergyJitter;  // extra jitter from volume (kept small — a light role)
uniform float uEnergyGlow;    // extra brightness from volume (kept small — a light role)
uniform float uVignette;
uniform float uGrain;

// An offset, glowing trace along the edges of things in the photo (a tree line, a
// horizon, a wave) — like a double-exposed outline that has drifted away from the
// real edge. Strength and offset distance both grow with mismatch.
uniform float uOutlineAmount;
uniform float uOutlineOffset;
uniform float uOutlineThreshold; // how strong an edge has to be before it's traced

// ---- Hash / noise ----
// hash: a "random" 0–1 value from a position, with no visible block artifacts.
// (The common one-line version, fract(sin(dot(...))*43758.5), showed square
// blocks on the GPU this was tested on: tiny rounding differences at a cell
// corner got blown up by the big multiplication after sin(). This version, by
// Dave Hoskins, has no sin and no huge numbers, so it doesn't happen.)
float hash(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}

// noise: blends the hashes of the 4 surrounding grid corners, smoothly.
// fbm: adds 4 layers of noise, each finer and fainter, for a cloud-like drift.
float noise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f); // smooth the blend, so no grid lines show
  return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), u.x),
             mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), u.x), u.y);
}

float fbm(vec2 p) {
  float sum = 0.0;
  float amount = 0.5;
  for (int i = 0; i < 4; i++) {
    sum += amount * noise(p);
    p = p * 2.03 + vec2(17.0, 9.0);
    amount *= 0.5;
  }
  return sum;
}

// Where to read an image so it covers the canvas without stretching (crops the
// longer side, like CSS "object-fit: cover"). zoom > 1 shows a smaller part.
vec2 cover(vec2 uv, vec2 size, float zoom) {
  float canvasAspect = uResolution.x / uResolution.y;
  float imageAspect = size.x / size.y;
  vec2 scale = canvasAspect > imageAspect
    ? vec2(1.0, imageAspect / canvasAspect) // canvas wider: crop top and bottom
    : vec2(canvasAspect / imageAspect, 1.0); // canvas taller: crop the sides
  return (uv - 0.5) * scale / zoom + 0.5;
}

// Reads an image, with red and blue sampled at a slightly different spot
// (chromatic aberration / colour fringes)
vec3 sampleImage(sampler2D image, vec2 size, float zoom, vec2 uv, vec2 split) {
  vec2 at = cover(uv, size, zoom);
  return vec3(texture2D(image, at + split).r,
              texture2D(image, at).g,
              texture2D(image, at - split).b);
}

float luma(vec3 colour) {
  return dot(colour, vec3(0.299, 0.587, 0.114));
}

// How much brightness changes right around this point — high where there's an
// edge in the photo (a shoreline, a tree against the sky), near 0 on a flat sky
// or a calm lake.
float edgeStrength(sampler2D image, vec2 size, float zoom, vec2 uv) {
  vec2 texel = 2.0 / uResolution;
  vec2 at = cover(uv, size, zoom);
  float here = luma(texture2D(image, at).rgb);
  float right = luma(texture2D(image, at + vec2(texel.x, 0.0)).rgb);
  float down = luma(texture2D(image, at + vec2(0.0, texel.y)).rgb);
  return length(vec2(right - here, down - here));
}

// What shows before any image has loaded: a dark background with a faint drift
vec3 emptyColour(vec2 p, float t) {
  vec3 base = vec3(0.04, 0.045, 0.05);
  return base + vec3(0.04, 0.05, 0.07) * fbm(p * 0.7 + t);
}

// Pushes a colour's channels apart from their shared average: more difference
// between R/G/B reads as more saturated. amount 0 = untouched.
vec3 boostSaturation(vec3 colour, float amount) {
  float average = (colour.r + colour.g + colour.b) / 3.0;
  return mix(colour, average + (colour - average) * 2.4, amount);
}

void main() {
  vec2 uv = vTexCoord;
  float aspect = uResolution.x / uResolution.y;

  // The mismatch in effect RIGHT NOW. It eases from the old value to the new one,
  // so the whole LOOK morphs rather than snapping. The easing happens in
  // semantic-view.js, every frame (CONFIG.visuals.mismatchEaseSeconds), so it
  // covers both a new image arriving and a new sound changing the current image's
  // mismatch while it is on screen. (Until 2026-11-20 it was done here, between a
  // value frozen at the switch and the live one; the frozen value turned out to be
  // the new one already, and a new sound made the look jump.)
  float m = uMismatch;

  // ---- Grid ----
  // A perfectly straight checkerboard looked too mechanical, so the grid itself
  // is bent by a slow, low-frequency drift before it's cut into cells — the
  // lines come out wavy and organic rather than ruler-straight. Barely there at
  // m = 0 (just enough to avoid a rigid lattice), more pronounced as m rises.
  vec2 gridWarpP = uv * 3.0 + vec2(0.0, uTime * 0.03);
  vec2 gridWarp = vec2(fbm(gridWarpP), fbm(gridWarpP + vec2(9.1, 2.7))) - 0.5;
  vec2 warpedUv = uv + gridWarp * (0.015 + 0.05 * m);

  // Two separate grids share this warp: the "look" grid, for the ambient jitter
  // below (its cell size grows with mismatch, fine at m = 0 to a block at m = 1),
  // and the dissolve's own, always-fine grid (further down) — see uDissolveGrid.
  float cellPx = mix(uGridFine, uGridCoarse, m);
  vec2 cellId = floor(warpedUv * uResolution / cellPx);
  float cellRandom = hash(cellId);

  // How "busy" things are right now: 1 while a switch is under way, settling to
  // a calmer baseline once the image has held for a moment (see visuals.js). A
  // floor keeps each effect from vanishing completely at rest — everything still
  // breathes a little — while most of its strength is reserved for the moment of
  // change, so a visitor gets a proper look at each image before it churns again.
  float settled = mix(0.5, 1.0, uActivity);

  // Each cell's sampling point is nudged sideways — barely at all when matched,
  // a visible jump when not, plus a touch more from the voice's volume (its one
  // allowed role here). The offset is a fraction of the CELL's own size, not of
  // the whole screen: without this, a tiny cell (fine grid, low m) got shifted
  // by more than its own width, sampling a near-random part of the image —
  // noise, not a light shimmer. A slow sway (rather than a fixed offset) keeps
  // it feeling alive instead of a block frozen out of place.
  float jitterStrength = uJitterAmount * m * settled + uEnergyJitter * uEnergy;
  vec2 jitterDir = vec2(hash(cellId + 11.0), hash(cellId + 71.0)) - 0.5;
  float sway = 0.6 + 0.4 * sin(uTime * 0.9 + cellRandom * 6.2831);
  vec2 cellSizeUv = cellPx / uResolution;
  vec2 sampleUv = uv + jitterDir * jitterStrength * cellSizeUv * 1.5 * sway;

  // ---- Glitch rects ----
  // A handful of small rectangular patches occasionally shift, like a corrupted
  // block in a video signal — not a full-width band any more (that read as the
  // whole picture sliding sideways, which was too much). Each patch is its own
  // small cell, on its own random schedule. More patches, more often, the higher
  // the mismatch; this is the one effect most tied to "a switch is under way"
  // (uActivity almost to the floor at rest), so the picture is mostly calm
  // between changes and properly glitchy right as a new one arrives.
  vec2 glitchId = floor(warpedUv * vec2(9.0, 5.0));
  float glitchBeat = floor(uTime * 1.7); // a fresh chance roughly every 0.6 s
  float glitchNoise = noise(glitchId * 3.7 + glitchBeat * 1.3);
  float glitchThreshold = 1.0 - uGlitchAmount * m * mix(0.15, 1.0, uActivity);
  float glitchOn = smoothstep(glitchThreshold, glitchThreshold + 0.08, glitchNoise);
  vec2 glitchShift = (vec2(hash(glitchId + glitchBeat), hash(glitchId + glitchBeat + 50.0)) - 0.5) * 0.1;
  sampleUv += glitchOn * glitchShift;

  // ---- Liquid warp ----
  // A slow drifting flow, like water pulling the image sideways. Strength comes
  // ONLY from mismatch — never from volume: a well-matched pair stays almost
  // still, a mismatched one visibly churns.
  vec2 flowP = vec2(uv.x * aspect, uv.y) * 2.4;
  float t = uTime * 0.05;
  vec2 flowDir = vec2(fbm(flowP + vec2(0.0, t)), fbm(flowP + vec2(5.2, 1.3) - vec2(t, 0.0))) - 0.47;
  sampleUv += flowDir * uWarpAmount * m * settled;

  // ---- Colour fringes ----
  vec2 split = (flowDir + vec2(0.3, 0.0)) * uAberrationAmount * m * settled;

  // ---- Read both images there ----
  vec3 empty = emptyColour(flowP, t);
  vec3 current = uHasCurrent > 0.5 ? sampleImage(uCurrent, uCurrentSize, uCurrentZoom, sampleUv, split) : empty;
  vec3 previous = uHasPrevious > 0.5 ? sampleImage(uPrevious, uPreviousSize, uPreviousZoom, sampleUv, split) : empty;

  // ---- The new image spreads out from the chosen label (step 3 of the redesign) ----
  // Until 2026-11-20 every cell flipped at a random moment, all over the picture.
  // Now a cell flips when the spreading front reaches it: the front starts at
  // uOrigin (the chosen label's box on screen) and grows until it has covered the
  // farthest corner. Each cell still gets a little randomness, on its own fixed,
  // fine grid (uDissolveGrid), so the front's edge is broken into small pieces
  // rather than a clean circle. A higher mismatch makes that edge more ragged.
  vec2 dissolveId = floor(warpedUv * uResolution / uDissolveGrid);
  float dissolveRandom = hash(dissolveId + 500.0); // +500: a different pattern from cellRandom
  vec2 cellCentre = (dissolveId + 0.5) * uDissolveGrid / uResolution;
  vec2 toOrigin = (cellCentre - uOrigin) * vec2(aspect, 1.0); // measured in screen heights
  // The farthest corner from the origin, so the front always covers everything
  vec2 farCorner = vec2(max(uOrigin.x, 1.0 - uOrigin.x) * aspect, max(uOrigin.y, 1.0 - uOrigin.y));
  float reach = length(toOrigin) / length(farCorner); // 0 at the origin … 1 at the farthest corner
  float roughness = uSpreadRoughness * (1.0 + m);
  float scatter = reach * (1.0 - roughness) + dissolveRandom * roughness;
  float edge = 0.06;
  float front = uTransition * (1.0 + 2.0 * edge) - edge;
  float shown = smoothstep(scatter - edge, scatter + edge, front);
  vec3 colour = mix(previous, current, shown);

  // A soft glow on the dissolving edge itself
  float rim = 1.0 - abs(shown * 2.0 - 1.0);
  colour += rim * 0.3 * vec3(1.0, 0.95, 0.85);

  // ---- Colour: pushed toward inverted and high-saturation as m rises ----
  colour = boostSaturation(colour, uSaturateAmount * m * settled);
  colour = mix(colour, 1.0 - colour, uInvertAmount * m * settled * 0.35);
  // an occasional full flash to negative colour — the most disruptive effect to
  // legibility, so it is almost entirely reserved for the moment of a switch
  // (uActivity, not the gentler "settled" floor): rare even at m = 1 right after
  // a change, and essentially off once an image has been sitting for a moment.
  // A continuous noise over time, not a per-beat coin flip, so it surges and
  // eases rather than popping on and off.
  float flashNoise = noise(vec2(7.0, uTime * 1.1));
  float flashThreshold = 1.0 - uInvertAmount * m * uActivity * 0.6;
  float flashActive = smoothstep(flashThreshold, flashThreshold + 0.08, flashNoise);
  colour = mix(colour, 1.0 - colour, flashActive * 0.85);

  // ---- Offset outline ----
  // A glowing trace along the edges of things in the photo (a shoreline, a tree
  // line), read slightly away from where the edge actually is — like a double
  // exposure that has drifted apart. Both the offset distance and how visible it
  // is grow with m; at m = 0 it is off. Traces an edge rather than hiding it, so
  // it is kept mostly present even at rest (a high floor), unlike the effects above.
  vec2 outlineAt = sampleUv + flowDir * uOutlineOffset * m;
  float edgeNow = uHasCurrent > 0.5 ? edgeStrength(uCurrent, uCurrentSize, uCurrentZoom, outlineAt) : 0.0;
  float traced = smoothstep(uOutlineThreshold, uOutlineThreshold + 0.05, edgeNow) * uOutlineAmount * m * mix(0.7, 1.0, uActivity);
  colour += traced * mix(vec3(1.0, 0.4, 0.75), vec3(0.4, 0.9, 1.0), cellRandom);

  // ---- Scanlines: the signature of a GOOD match. Fades out as m rises, handing
  // over to the blockier, glitchier look above. ----
  float scanline = 0.5 + 0.5 * sin(uv.y * uResolution.y * 1.4);
  colour *= 1.0 - uScanlineAmount * (1.0 - m) * (1.0 - scanline) * 0.55;

  // ---- Volume's one allowed effect here: a light brightness pulse ----
  colour *= 1.0 + uEnergyGlow * uEnergy;

  // ---- Finish: vignette and grain ----
  vec2 fromCentre = (uv - 0.5) * vec2(aspect, 1.0);
  float corner = length(fromCentre) / length(vec2(aspect, 1.0) * 0.5); // 0 centre … 1 corner
  colour *= 1.0 - uVignette * smoothstep(0.4, 1.0, corner);
  colour += (hash(uv * uResolution + fract(uTime) * 97.0) - 0.5) * uGrain * (0.6 + 0.4 * m);

  // (The live input spectrum used to be painted in here too; since the two-screen
  // redesign it has its own screen — src/views/sound/.)
  gl_FragColor = vec4(clamp(colour, 0.0, 1.0), 1.0);
}
