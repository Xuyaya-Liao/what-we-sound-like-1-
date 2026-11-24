// semantic-view.js: the semantic screen, "what we say" (two-screen redesign).
//
// The image, drawn by a shader that mismatch distorts (step 10), and on top of it
// the ring of the visitor's words with the image labels linked to them
// (word-overlay.js, step 3 of DESIGN-two-screens.md). A new image spreads out from
// the chosen label's box.
//
// It never touches the microphone or the models. Everything arrives through the bus
// (src/shared/bus.js), so the same code runs in its own window (semantic.html, on the
// second display) or next to the sound screen in one window (index.html?view=both).
//
// The canvas is drawn by a shader: a small program that runs on the graphics card
// once for every pixel, every frame. It is in two files next to this one:
//   shaders/image.vert  places the rectangle that covers the screen (rarely needs changing)
//   shaders/image.frag  decides each pixel's colour: this is where the look is made
// This file gathers what the shader needs — the images, the time, the voice's
// energy, mismatch, and every setting under CONFIG.visuals — and hands it over as
// "uniforms", values that are the same for every pixel in one frame.
//
// p5 "instance mode": every p5 function is written p.something. WEBGL mode: the
// canvas is drawn by the graphics card.

import { CONFIG } from "../../config.js";
import { createMatchLookup } from "../../shared/match.js";
import { createWordOverlay } from "./word-overlay.js";

// Each image is shown a little bigger than the screen, so the slow zoom and the
// flow never pull an edge into view
const OVERSCAN = 1.04;

// container: the element to draw in. bus: see src/shared/bus.js.
// onFirstMessage: called once, when the engine is first heard from (to hide "waiting…")
export function createSemanticView(container, bus, { onFirstMessage } = {}) {
  const overlay = createWordOverlay(container); // words and labels: a 2D layer drawn over the shader

  // What the engine has told us, read every frame by the sketch
  const state = {
    levelDb: -Infinity,
    mismatch: 0.25, // where mismatch is heading: the latest value from the engine
  };
  let showPicture = () => {}; // set inside the sketch, which owns the images
  let showDark = () => {}; // likewise: dissolve the image away to the dark background
  let origin = [0.5, 0.5]; // where the next image spreads out from (0–1, 0–1, top-left = 0, 0)

  let heard = false;
  const listen = (type, handler) =>
    bus.on(type, (data) => {
      if (!heard) {
        heard = true;
        onFirstMessage?.();
      }
      handler(data);
    });

  listen("matchTable", (table) => overlay.setMatch(createMatchLookup(table)));
  listen("level", ({ db }) => (state.levelDb = db ?? -Infinity));
  listen("sound", ({ chosen }) => overlay.setSoundCategory(chosen?.category));
  listen("mismatch", ({ value }) => (state.mismatch = value));
  listen("words", (words) => overlay.setWords(words));
  listen("image", (image) => {
    state.mismatch = image.mismatch;
    if (image.soundCategory) overlay.setSoundCategory(image.soundCategory);
    const from = overlay.addRound(image.analysis, image.file);
    origin = [from.x, from.y];
    showPicture(image.file);
  });
  listen("reset", () => overlay.reset());
  // No words for a while: back to the dark screen (the image dissolves from the
  // centre into the dark background; the words and labels go)
  listen("dark", () => {
    overlay.clear();
    origin = [0.5, 0.5];
    state.mismatch = 0; // a calm dark, not a glitching one
    showDark();
  });
  listen("end", () => (state.levelDb = -Infinity));
  // A screen opened late: the engine's latest state, so it doesn't stay empty until
  // the next round (see bus.js). Only the snapshot answering THIS screen's hello:
  // a screen already running must not re-show its image.
  const id = Math.random().toString(36).slice(2);
  listen("snapshot", ({ to, matchTable, sound, words, image, mismatch }) => {
    if (to !== id) return;
    if (matchTable) overlay.setMatch(createMatchLookup(matchTable));
    if (sound) overlay.setSoundCategory(sound.chosen?.category);
    if (words) overlay.setWords(words);
    if (image) {
      state.mismatch = image.mismatch;
      overlay.addRound(image.analysis, image.file);
      showPicture(image.file);
    }
    // A later sound may have changed how well that image fits
    if (Number.isFinite(mismatch?.value) && mismatch.label === image?.label) state.mismatch = mismatch.value;
  });

  const sketch = (p) => {
    let imageShader; // the shader program, once loaded
    let energy = 0; // 0 = silent, 1 = loud; smoothed from state.levelDb
    let shownMismatch = state.mismatch; // eased towards state.mismatch, every frame
    let lastFrame = 0;
    let current; // the image dissolving in, or already shown: { picture, since }
    let previous; // the image it is dissolving over
    let transitionSince = 0;
    let spreadFrom = [0.5, 0.5]; // the origin of the spread now under way
    let requests = 0; // counts showPicture calls, so a slow download can't replace a newer image
    let blank; // a 1×1 stand-in for an empty image slot (see setPicture)

    // The current image dissolves into the dark background, the same way a new image
    // arrives (the shader draws its dark drift where there is no image)
    showDark = () => {
      ++requests; // an image still downloading must not appear afterwards
      if (!current) return; // already dark
      if (previous) forgetTexture(previous.picture);
      previous = current;
      current = undefined;
      transitionSince = p.millis();
      spreadFrom = origin;
    };

    showPicture = async (file) => {
      const ticket = ++requests;
      let picture;
      try {
        picture = await p.loadImage(file); // download and decode; "await" waits for it
      } catch (error) {
        console.error(`Could not load ${file}:`, error);
        return;
      }
      if (ticket !== requests) return; // a newer image was asked for meanwhile
      shrink(picture);

      // The outgoing "previous" (two images back) is never drawn again from this
      // point on — free its graphics memory now, then move the chain along. This
      // runs with no "await" in between, so no draw() frame can see a texture
      // freed out from under it (see the comment on forgetTexture, below).
      if (previous) forgetTexture(previous.picture);
      previous = current;
      current = { picture, since: p.millis() };
      transitionSince = p.millis();
      spreadFrom = origin; // fixed for this whole spread, even if another round arrives
    };

    // "async": setup waits for the shader files to load before draw() starts
    p.setup = async () => {
      p.createCanvas(container.clientWidth, container.clientHeight, p.WEBGL);
      p.pixelDensity(CONFIG.visuals.pixelDensity);
      p.noStroke();
      imageShader = await p.loadShader(
        new URL("./shaders/image.vert", import.meta.url).href,
        new URL("./shaders/image.frag", import.meta.url).href,
      );
      // Follow the container's size (the whole window, or half of it with ?view=both)
      new ResizeObserver(() => {
        p.resizeCanvas(container.clientWidth, container.clientHeight);
        overlay.resize();
      }).observe(container);
    };

    p.draw = () => {
      if (!imageShader) return;
      const settings = CONFIG.visuals;
      const now = p.millis();
      const seconds = Math.min(0.1, (now - lastFrame) / 1000); // since the last frame
      lastFrame = now;

      // Loudness → energy: rises quickly (attack), falls back slowly (release)
      const target = p.constrain(p.map(state.levelDb, settings.quietDb, settings.loudDb, 0, 1), 0, 1);
      energy += (target - energy) * (target > energy ? settings.attack : settings.release);

      // Mismatch glides to its new value instead of jumping: when a new image
      // arrives, and also when a new sound changes how well the current image fits.
      // Measured in seconds, not frames, so it looks the same at any frame rate.
      shownMismatch += (state.mismatch - shownMismatch) * (1 - Math.exp(-seconds / settings.mismatchEaseSeconds));

      const transitionMs = settings.transitionSeconds * 1000;
      const transition = Math.min(1, (now - transitionSince) / transitionMs);

      // How "busy" things should be right now: 1 while the dissolve is actually
      // under way, easing down to a calmer resting level over settleSeconds once
      // it finishes, so each image gets a proper, readable moment before the next
      // change (see the shader's "settled"/uActivity comments).
      const settleT = Math.min(1, Math.max(0, now - transitionSince - transitionMs) / (settings.settleSeconds * 1000));
      const activity = 1 - settleT * (1 - settings.restActivity);

      p.shader(imageShader);
      const set = (name, value) => imageShader.setUniform(name, value);
      set("uResolution", [p.width, p.height]);
      set("uTime", (now / 1000) % 1000); // seconds; wrapped so the numbers stay precise
      set("uEnergy", energy);
      set("uTransition", transition);
      set("uActivity", activity);
      set("uMismatch", shownMismatch);
      set("uOrigin", spreadFrom); // where the new image spreads out from
      set("uSpreadRoughness", CONFIG.semanticScreen.spreadRoughness);
      setPicture("Current", current, now);
      setPicture("Previous", previous, now);

      // The settings, straight from config.js
      set("uWarpAmount", settings.warpAmount);
      set("uAberrationAmount", settings.aberrationAmount);
      set("uInvertAmount", settings.invertAmount);
      set("uSaturateAmount", settings.saturateAmount);
      set("uGlitchAmount", settings.glitchAmount);
      set("uJitterAmount", settings.jitterAmount);
      set("uScanlineAmount", settings.scanlineAmount);
      set("uGridFine", settings.gridFine);
      set("uGridCoarse", settings.gridCoarse);
      set("uDissolveGrid", settings.dissolveGrid);
      set("uOutlineAmount", settings.outlineAmount);
      set("uOutlineOffset", settings.outlineOffset);
      set("uOutlineThreshold", settings.outlineThreshold);
      set("uEnergyJitter", settings.energyJitter);
      set("uEnergyGlow", settings.energyGlow);
      set("uVignette", settings.vignette);
      set("uGrain", settings.grain);

      // One rectangle the size of the canvas; the shader colours every pixel of it
      p.plane(p.width, p.height);

      overlay.draw(performance.now());
    };

    // uCurrent / uPrevious: the image itself, its size, how far it has zoomed in,
    // and whether there is one at all (before the first image, there isn't).
    // With no image, the slot gets a blank 1×1 stand-in: left alone, it would still
    // point at the image last drawn there, which forgetTexture may have freed since,
    // and p5 then fails on every frame. (Bug fixed 2026-11-23: after the dark screen,
    // the next image never appeared until the page was reloaded.)
    function setPicture(name, shown, now) {
      imageShader.setUniform(`uHas${name}`, shown ? 1 : 0);
      if (!shown) {
        blank ??= p.createImage(1, 1);
        imageShader.setUniform(`u${name}`, blank);
        return;
      }
      const { picture, since } = shown;
      const settings = CONFIG.visuals;
      const age = Math.min(1, (now - since) / (settings.zoomSeconds * 1000));
      imageShader.setUniform(`u${name}`, picture);
      imageShader.setUniform(`u${name}Size`, [picture.width, picture.height]);
      imageShader.setUniform(`u${name}Zoom`, OVERSCAN + settings.zoomPerImage * age);
    }

    function shrink(picture) {
      const maxSide = CONFIG.visuals.maxImageSide;
      if (Math.max(picture.width, picture.height) <= maxSide) return;
      // resize(width, 0): 0 means "keep the proportions"
      if (picture.width >= picture.height) picture.resize(maxSide, 0);
      else picture.resize(0, maxSide);
    }

    // p5 copies every image it draws into graphics memory and keeps it there, in
    // case it is drawn again. The piece draws from a library of up to ~180
    // images over a whole visit, so without this it would only grow. An image is
    // freed the moment it is no longer one of the (at most) two being drawn —
    // see showPicture, above, which calls this with no "await" before reassigning
    // the variable that pointed to it, so no draw() frame ever sees a texture
    // that was removed out from under it. (This uses p5's internal
    // _renderer.textures, the same way p5 frees its own text textures.)
    function forgetTexture(picture) {
      const textures = p._renderer?.textures;
      const texture = textures?.get(picture);
      if (!texture) return;
      texture.remove();
      textures.delete(picture);
    }
  };

  // window.p5 comes from p5.min.js, which the page loads with a <script> tag
  new window.p5(sketch, container);

  // Ask the engine for its latest state, in case it is already running
  bus.publish("hello", { id });
}
