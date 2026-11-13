// lab.js: the visuals v2 experiment page. A standalone tool — it does not touch
// src/ or the real piece at all — for tuning the look before it goes into the
// real app. Every slider on the page is one number the shader uses (see the long
// comment at the top of shaders/image.frag for what each one does and why).
//
// How "mismatch" works here, since there is no real sound or LLM in this page:
// the Mismatch slider always represents the image CURRENTLY on screen, live —
// drag it and the look changes at once. Click "Switch image" to bring in a new
// one: the old image's mismatch is frozen at whatever the slider said at that
// moment (so the hand-over eases from "what it just was" to "what it is now"),
// and the slider keeps driving the new image from then on.

const OVERSCAN = 1.04; // each image is shown slightly bigger than the screen
const ZOOM_PER_IMAGE = 0.05; // slow zoom over the time below, so a still image
const ZOOM_SECONDS = 25; // never looks frozen, same as in the real piece

// One sample image per label, so the lab has some variety to test on
const SAMPLES = [
  { label: "still_water", file: "../../assets/images/wc-109960432.jpg" },
  { label: "storm", file: "../../assets/images/wc-12140911.jpg" },
  { label: "volcano", file: "../../assets/images/wc-142309356.jpg" },
  { label: "forest", file: "../../assets/images/wc-102119666.jpg" },
  { label: "aurora", file: "../../assets/images/wc-1234235.jpg" },
  { label: "desert", file: "../../assets/images/wc-107571977.jpg" },
  { label: "pollinators", file: "../../assets/images/inat-101116781.jpg" },
  { label: "night_sky", file: "../../assets/images/wc-110735605.jpg" },
];

// Every slider on the page, in the order shown. "group" only affects how they
// are laid out. The shader comments explain what each uniform does.
const CONTROLS = [
  { group: "The two numbers that matter most", key: "mismatch", label: "Mismatch (m)", min: 0, max: 1, step: 0.01, value: 0.15 },
  { group: "The two numbers that matter most", key: "energy", label: "Energy (volume, light role only)", min: 0, max: 1, step: 0.01, value: 0 },

  { group: "Effect strengths at m = 1, full activity", key: "warpAmount", label: "Liquid warp", min: 0, max: 0.3, step: 0.005, value: 0.08 },
  { group: "Effect strengths at m = 1, full activity", key: "aberrationAmount", label: "Chromatic aberration", min: 0, max: 0.05, step: 0.001, value: 0.012 },
  { group: "Effect strengths at m = 1, full activity", key: "invertAmount", label: "Colour invert / flash", min: 0, max: 1, step: 0.01, value: 0.5 },
  { group: "Effect strengths at m = 1, full activity", key: "saturateAmount", label: "Saturation boost", min: 0, max: 1, step: 0.01, value: 0.55 },
  { group: "Effect strengths at m = 1, full activity", key: "glitchAmount", label: "Glitch patches", min: 0, max: 1, step: 0.01, value: 0.55 },
  { group: "Effect strengths at m = 1, full activity", key: "jitterAmount", label: "Grid-cell jitter", min: 0, max: 1, step: 0.01, value: 0.5 },
  { group: "Effect strengths at m = 1, full activity", key: "scanlineAmount", label: "Scanlines (fades OUT as m rises)", min: 0, max: 1, step: 0.01, value: 0.5 },

  { group: "Grid size", key: "gridFine", label: "Look cell size at m = 0 (px)", min: 0.5, max: 8, step: 0.25, value: 1.2 },
  { group: "Grid size", key: "gridCoarse", label: "Look cell size at m = 1 (px)", min: 10, max: 90, step: 1, value: 24 },
  { group: "Grid size", key: "dissolveGrid", label: "Dissolve cell size, fixed (px)", min: 3, max: 40, step: 1, value: 9 },

  { group: "Offset outline", key: "outlineAmount", label: "Strength at m = 1", min: 0, max: 1, step: 0.01, value: 0.5 },
  { group: "Offset outline", key: "outlineOffset", label: "Offset distance at m = 1", min: 0, max: 0.08, step: 0.002, value: 0.02 },
  { group: "Offset outline", key: "outlineThreshold", label: "Edge threshold (lower = traces more)", min: 0.02, max: 0.5, step: 0.01, value: 0.12 },

  { group: "Volume's light role", key: "energyJitter", label: "Extra jitter", min: 0, max: 0.4, step: 0.01, value: 0.15 },
  { group: "Volume's light role", key: "energyGlow", label: "Extra brightness", min: 0, max: 0.3, step: 0.01, value: 0.08 },

  { group: "Finish", key: "vignette", label: "Vignette", min: 0, max: 0.8, step: 0.01, value: 0.4 },
  { group: "Finish", key: "grain", label: "Grain", min: 0, max: 0.1, step: 0.002, value: 0.03 },

  { group: "Switching", key: "transitionSeconds", label: "Transition length (s)", min: 0.3, max: 8, step: 0.1, value: 1.6 },
  { group: "Switching", key: "settleSeconds", label: "Settle time after (s)", min: 0.2, max: 6, step: 0.1, value: 2.5 },
  { group: "Switching", key: "restActivity", label: "Resting activity (0 = calmest)", min: 0, max: 1, step: 0.01, value: 0.3 },
  { group: "Switching", key: "autoSeconds", label: "Auto-cycle every (s)", min: 1, max: 15, step: 0.5, value: 4 },
];

const state = Object.fromEntries(CONTROLS.map((c) => [c.key, c.value]));

let showNext; // showNext(): switches to a different sample image (set by the sketch)
let currentLabel = ""; // for the readout

const sketch = (p) => {
  let imageShader;
  let pictures = []; // [{ label, picture }]
  let currentIndex = -1;

  let currentPicture, previousPicture; // the loaded p5.Image currently shown/shown before
  let currentSince = 0, previousSince = 0; // millis(), for the slow zoom
  let transitionSince = 0;
  let previousMismatchFrozen = 0; // the outgoing image's mismatch, frozen at the switch

  showNext = () => {
    if (!pictures.length) return;
    let nextIndex = currentIndex;
    while (nextIndex === currentIndex && pictures.length > 1) {
      nextIndex = Math.floor(Math.random() * pictures.length);
    }
    currentIndex = nextIndex;

    previousPicture = currentPicture;
    previousSince = currentSince;
    previousMismatchFrozen = state.mismatch; // whatever it just said, freeze it

    currentPicture = pictures[currentIndex].picture;
    currentSince = p.millis();
    currentLabel = pictures[currentIndex].label;
    transitionSince = p.millis();

    // Once this transition is visually done, stop referencing the old image at
    // all (its "has" uniform goes to 0, so the shader skips it entirely). The
    // lab only ever cycles through 8 fixed images, so p5 just keeps all 8
    // textures in graphics memory for the session — a small, bounded amount.
    // The real app, which draws from a much bigger, constantly-changing image
    // library, will need to actually free each texture once it's done with it;
    // this lab is not the place to get that GPU-memory bookkeeping right.
    const outgoing = previousPicture;
    setTimeout(() => {
      if (previousPicture === outgoing) previousPicture = undefined;
    }, (state.transitionSeconds + 0.5) * 1000);
  };

  p.setup = async () => {
    p.createCanvas(p.windowWidth, p.windowHeight, p.WEBGL);
    p.pixelDensity(1);
    p.noStroke();

    const [shader, ...loaded] = await Promise.all([
      p.loadShader(new URL("./shaders/image.vert", import.meta.url).href, new URL("./shaders/image.frag", import.meta.url).href),
      ...SAMPLES.map((sample) => p.loadImage(sample.file)),
    ]);
    imageShader = shader;
    pictures = SAMPLES.map((sample, i) => ({ label: sample.label, picture: loaded[i] }));
    showNext();
  };

  p.draw = () => {
    if (!imageShader) return;
    const now = p.millis();
    const transitionMs = state.transitionSeconds * 1000;
    const transition = Math.min(1, (now - transitionSince) / transitionMs);

    // Same formula as the real app's visuals.js: 1 while the dissolve is under
    // way, easing down to restActivity over settleSeconds once it finishes.
    const settleT = Math.min(1, Math.max(0, now - transitionSince - transitionMs) / (state.settleSeconds * 1000));
    const activity = 1 - settleT * (1 - state.restActivity);

    p.shader(imageShader);
    const set = (name, value) => imageShader.setUniform(name, value);
    set("uResolution", [p.width, p.height]);
    set("uTime", (now / 1000) % 1000);
    set("uTransition", transition);
    set("uActivity", activity);
    set("uMismatch", state.mismatch);
    set("uPrevMismatch", previousMismatchFrozen);
    set("uEnergy", state.energy);

    set("uWarpAmount", state.warpAmount);
    set("uAberrationAmount", state.aberrationAmount);
    set("uInvertAmount", state.invertAmount);
    set("uSaturateAmount", state.saturateAmount);
    set("uGlitchAmount", state.glitchAmount);
    set("uJitterAmount", state.jitterAmount);
    set("uScanlineAmount", state.scanlineAmount);
    set("uGridFine", state.gridFine);
    set("uGridCoarse", state.gridCoarse);
    set("uDissolveGrid", state.dissolveGrid);
    set("uEnergyJitter", state.energyJitter);
    set("uEnergyGlow", state.energyGlow);
    set("uVignette", state.vignette);
    set("uGrain", state.grain);
    set("uOutlineAmount", state.outlineAmount);
    set("uOutlineOffset", state.outlineOffset);
    set("uOutlineThreshold", state.outlineThreshold);

    setPicture("Current", currentPicture, currentSince, now);
    setPicture("Previous", previousPicture, previousSince, now);

    p.plane(p.width, p.height);

    const readout = document.getElementById("readout");
    if (readout) {
      readout.textContent =
        `showing: ${currentLabel}  ·  transition ${(transition * 100).toFixed(0)}%  ·  activity ${activity.toFixed(2)}  ·  ` +
        `m (current) ${state.mismatch.toFixed(2)}  ·  m (previous, frozen) ${previousMismatchFrozen.toFixed(2)}`;
    }
  };

  function setPicture(name, picture, since, now) {
    imageShader.setUniform(`uHas${name}`, picture ? 1 : 0);
    if (!picture) return;
    const age = Math.min(1, (now - since) / (ZOOM_SECONDS * 1000));
    imageShader.setUniform(`u${name}`, picture);
    imageShader.setUniform(`u${name}Size`, [picture.width, picture.height]);
    imageShader.setUniform(`u${name}Zoom`, OVERSCAN + ZOOM_PER_IMAGE * age);
  }

  p.windowResized = () => {
    p.resizeCanvas(p.windowWidth, p.windowHeight);
  };
};

new window.p5(sketch, document.getElementById("stage"));

// ---- The control panel ----
// Built from the CONTROLS list above: one slider per entry, grouped under
// headings, each one writing straight into `state`. setControl(key, value) moves
// a slider and updates its value text from code (used by auto-cycle, below).
const sliderElements = {}; // key -> { input, valueText }

function buildPanel() {
  const panel = document.getElementById("panel-controls");
  let lastGroup;
  for (const control of CONTROLS) {
    if (control.group !== lastGroup) {
      lastGroup = control.group;
      const heading = document.createElement("p");
      heading.className = "group";
      heading.textContent = control.group;
      panel.append(heading);
    }

    const row = document.createElement("label");
    row.className = "row";
    const valueText = document.createElement("span");
    valueText.className = "value";
    valueText.textContent = control.value;

    const title = document.createElement("span");
    title.textContent = control.label;

    const input = document.createElement("input");
    input.type = "range";
    input.min = control.min;
    input.max = control.max;
    input.step = control.step;
    input.value = control.value;
    input.addEventListener("input", () => {
      state[control.key] = Number(input.value);
      valueText.textContent = input.value;
    });

    row.append(title, input, valueText);
    panel.append(row);
    sliderElements[control.key] = { input, valueText };
  }
}
buildPanel();

function setControl(key, value) {
  state[key] = value;
  const element = sliderElements[key];
  if (element) {
    element.input.value = value;
    element.valueText.textContent = element.input.value; // rounded to the slider's step
  }
}

// ---- Switch / auto-cycle / copy settings ----
document.getElementById("switch-button").addEventListener("click", showNext);

let autoTimer;
document.getElementById("auto-toggle").addEventListener("change", (event) => {
  clearInterval(autoTimer);
  if (!event.target.checked) return;
  autoTimer = setInterval(() => {
    setControl("mismatch", Math.random()); // a fresh, random mismatch for the next image
    showNext();
  }, state.autoSeconds * 1000);
});

document.getElementById("copy-button").addEventListener("click", async () => {
  const text = JSON.stringify(state, null, 2);
  try {
    await navigator.clipboard.writeText(text);
    document.getElementById("copy-status").textContent = "Copied — paste it in chat.";
  } catch {
    document.getElementById("copy-status").textContent = text; // clipboard blocked: show it instead
  }
});
