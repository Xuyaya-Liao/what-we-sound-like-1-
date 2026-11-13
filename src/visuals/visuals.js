// visuals.js: everything the visitor sees (steps 7 and 10).
//
// The canvas is drawn by a shader: a small program that runs on the graphics card
// once for every pixel, every frame. It is in two files next to this one:
//   shaders/image.vert  places the rectangle that covers the screen (rarely needs changing)
//   shaders/image.frag  decides each pixel's colour: this is where the look is made
// This file gathers what the shader needs — the images, the time, the voice's
// energy, mismatch, and every setting under CONFIG.visuals — and hands it over as
// "uniforms", values that are the same for every pixel in one frame.
//
// The look was designed and tuned in a separate tool first: experiments/visuals-lab/
// (a page with sliders, not touching this file or main.js at all). This file is
// that same shader, wired to the real piece instead of slider values:
//   · mismatch comes from main.js, in live.mismatch (set each round once both the
//     sound and the image are known — see main.js's showImage())
//   · energy comes from the voice's loudness, live.levelDb, smoothed here
// Both apply continuously, for as long as an image is on screen — not just during
// the moment of switching to it. See the long comment at the top of
// shaders/image.frag for the full design: what mismatch does to the look, and
// why the voice's volume only ever gets a light, secondary role.
//
// p5 "instance mode" (see the note in main.js): every p5 function is written
// p.something. WEBGL mode: the canvas is drawn by the graphics card.

import { CONFIG } from "../config.js";
import { createHud } from "./hud.js";

// Each image is shown a little bigger than the screen, so the slow zoom and the
// flow never pull an edge into view
const OVERSCAN = 1.04;

// container: the element the canvas goes into
// live: values shared with main.js — reads live.levelDb (loudness) and
//   live.mismatch (set once per round by main.js, see showImage())
// Returns { showPicture(file), showAnalysis(data) }:
//   showPicture: starts dissolving to this image; resolves once the dissolve
//     has started (not once it's finished)
//   showAnalysis: adds one round's results to the embedding HUD (hud.js) — the
//     sound and label candidates, which were chosen, and mismatch
export function createVisuals(container, live) {
  let showPicture; // set inside the sketch, which owns the images
  const hud = createHud(container); // the embedding HUD: a 2D layer drawn over the shader

  const sketch = (p) => {
    let imageShader; // the shader program, once loaded
    let energy = 0; // 0 = silent, 1 = loud; smoothed from live.levelDb
    let current; // the image dissolving in, or already shown: { picture, since }
    let previous; // the image it is dissolving over
    let previousMismatchFrozen = 0; // mismatch the OUTGOING image had, frozen at the switch
    let transitionSince = 0;
    let requests = 0; // counts showPicture calls, so a slow download can't replace a newer image

    showPicture = async (file) => {
      const ticket = ++requests;
      const picture = await p.loadImage(file); // download and decode; "await" waits for it
      if (ticket !== requests) return; // a newer image was asked for meanwhile
      shrink(picture);

      // The outgoing "previous" (two images back) is never drawn again from this
      // point on — free its graphics memory now, then move the chain along. This
      // runs with no "await" in between, so no draw() frame can see a texture
      // freed out from under it (see the comment on forgetTexture, below).
      if (previous) forgetTexture(previous.picture);
      previous = current;
      previousMismatchFrozen = live.mismatch ?? 0;
      current = { picture, since: p.millis() };
      transitionSince = p.millis();
    };

    // "async": setup waits for the shader files to load before draw() starts
    p.setup = async () => {
      p.createCanvas(p.windowWidth, p.windowHeight, p.WEBGL);
      p.pixelDensity(CONFIG.visuals.pixelDensity);
      p.noStroke();
      imageShader = await p.loadShader(
        new URL("./shaders/image.vert", import.meta.url).href,
        new URL("./shaders/image.frag", import.meta.url).href,
      );
    };

    p.draw = () => {
      if (!imageShader) return;
      const settings = CONFIG.visuals;
      const now = p.millis();

      // Loudness → energy: rises quickly (attack), falls back slowly (release)
      const target = p.constrain(p.map(live.levelDb, settings.quietDb, settings.loudDb, 0, 1), 0, 1);
      energy += (target - energy) * (target > energy ? settings.attack : settings.release);

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
      set("uMismatch", live.mismatch ?? 0);
      set("uPrevMismatch", previousMismatchFrozen);
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

      // The HUD keeps a steady jitter over the image transition.
      hud.draw(performance.now());
    };

    // uCurrent / uPrevious: the image itself, its size, how far it has zoomed in,
    // and whether there is one at all (before the first image, there isn't)
    function setPicture(name, shown, now) {
      imageShader.setUniform(`uHas${name}`, shown ? 1 : 0);
      if (!shown) return;
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

    // When the window is resized, resize the canvas (and the HUD's) with it
    p.windowResized = () => {
      p.resizeCanvas(p.windowWidth, p.windowHeight);
      hud.resize();
    };
  };

  // window.p5 comes from p5.min.js, which index.html loads with a <script> tag
  new window.p5(sketch, container);

  return {
    showPicture: (file) => showPicture(file),
    showAnalysis: (data) => hud.addRound(data),
  };
}
