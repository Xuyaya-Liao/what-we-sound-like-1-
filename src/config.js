// config.js: every adjustable setting lives here.
// To change the rhythm or swap a model later, edit only this file.
// Each entry notes the step where it starts being used.

export const CONFIG = {
  // Process one chunk of sound every N seconds (step 3)
  roundSeconds: 5,

  // Sample rates the two models expect: CLAP wants 48000 Hz, Whisper wants 16000 Hz (step 3)
  soundSampleRate: 48000,
  speechSampleRate: 16000,

  // A segment quieter than this (in dBFS) counts as "quiet": nobody is speaking.
  // Normal speech near a laptop mic is around -35 to -20; a quiet room is below -55.
  // If quiet rounds get marked as "voice", lower this number; if speech gets
  // marked "quiet", raise it. (step 3)
  quietBelowDb: -50,

  // After this many rounds in a row with no words (quiet, or nothing Whisper
  // recognised), the nature sounds fade out and both screens go back to dark, until
  // the next words (2026-11-21). 1 = straight away; 2 = a short pause (5 s) doesn't
  // darken, a longer one does.
  darkAfterSilentRounds: 2, // about 10 s (was 4, changed 2026-11-23)

  // Microphone settings (step 3). Browsers "clean up" voices by default; for this
  // piece we want the raw timbre, so we only keep echo cancellation, which stops
  // the nature sounds coming out of the speakers from being heard as the visitor.
  microphone: {
    echoCancellation: true,
    noiseSuppression: false, // would smooth away breath and texture
    autoGainControl: false, // would even out loud and soft speaking
  },

  // Models (steps 4 and 5). Each name is the model's address on Hugging Face.
  // Visitors may speak any language: speech is transcribed in its original
  // language (never translated), so both text models below are multilingual.
  models: {
    sound: "Xenova/clap-htsat-unfused", // the same CLAP as the professor's example and the demo
    fallbackText: "Xenova/paraphrase-multilingual-MiniLM-L12-v2", // fallback: multilingual text embedding
  },

  // transformers.js version, the same as the demo (step 4)
  transformersUrl: "https://cdn.jsdelivr.net/npm/@huggingface/transformers@4.3.2",

  // Speech recognition (step 5): multilingual Whisper, which detects the language itself.
  speech: {
    // Whisper hears the last 10 s (the previous round + this one), still once every 5 s.
    // A sentence cut in half at a round boundary is then heard whole the next time.
    listenSeconds: 10,
    // An early look, so the words reach the semantic screen's ring sooner (2026-11-21):
    // this far into each round, Whisper also hears the last round + the part of this one
    // collected so far, and any new words go onto the ring straight away. Only the
    // ring: the sound and the image still change together, at the end of the round.
    // 0 = off. On the processor ("base · CPU") Whisper is too slow to do this as well
    // as the full round, so it only runs on the graphics card unless peekOnCpu is true.
    peekSeconds: 2.5,
    peekOnCpu: false,
    // Which Whisper to use. The first one this computer can run is used:
    //   gpu: "small" on the graphics card (WebGPU). Much more accurate, ~1–2 s per round.
    //        Needs a browser with WebGPU and a GPU that does 16-bit maths ("shader-f16").
    //   cpu: "base" on the processor. Works everywhere, less accurate, ~2.5–3.5 s.
    // dtype is how strongly each part is compressed: fp16 = 16-bit, q4 / q8 = 4- / 8-bit.
    gpu: {
      model: "onnx-community/whisper-small",
      device: "webgpu",
      dtype: { encoder_model: "fp16", decoder_model_merged: "q4" },
      name: "small · GPU",
    },
    cpu: {
      model: "onnx-community/whisper-base",
      device: "wasm",
      dtype: "q8",
      name: "base · CPU",
    },
  },

  // The LLM that chooses the label from what was said (step 6, see src/semantic/llm-label.js).
  // Every question costs tokens (money on the OpenRouter account), so it is off by default:
  //   "off": only the local text model chooses. No tokens, no key needed.
  //   "on":  the LLM chooses; the local answer shows first and stays if the LLM fails.
  // While developing, leave this "off" and add ?llm=on to the address bar to test the LLM
  // for one visit (?llm=off does the opposite).
  llm: {
    mode: "off",
    // The model's name on OpenRouter. About 700 tokens per question; at $0.10 per million
    // prompt tokens and $0.50 per million answer tokens (2026-11-12), 1000 questions ≈ $0.07.
    model: "anthropic/claude-haiku-5.5",
    url: "https://openrouter.ai/api/v1/chat/completions",
    maxTokens: 10, // the answer is one label id, a few tokens
    // How long the LLM "thinks" before answering. OpenRouter's default for this model is
    // "medium": it thinks first, and the thinking used up the 10 tokens before the
    // answer, so the reply came back empty. Choosing a label doesn't need it: "none".
    reasoning: "none",
    timeoutSeconds: 4, // no answer by then: keep the local label
  },

  // The images (step 7, see src/image/image-choice.js). Each time a label is chosen,
  // the next image from that label's shuffle bag is drawn (how it appears is up to
  // the visuals, below).
  images: {
    recent: 4, // avoid the last 4 images shown (at most half of a label's images)
  },

  // The visuals (step 10). Since the two-screen redesign (DESIGN-two-screens.md):
  // soundVisualization is the sound screen's ring (src/views/sound/), visuals is the
  // semantic screen's image shader (src/views/semantic/). Most of visuals is also a slider in the
  // design tool at experiments/visuals-lab/ — tune it there first, then copy the
  // numbers here. The whole look is driven by TWO numbers computed each round:
  //   mismatch (0–1): how well the chosen sound's category and the chosen image's
  //     label agree (src/semantic — the text model compares their descriptions).
  //     0 = they agree, the picture looks like itself. 1 = they don't, and the
  //     picture dissolves into colour, glitch and liquid distortion.
  //   energy (0–1): the voice's current loudness, smoothed. Only ever a LIGHT,
  //     secondary role here (see energyJitter / energyGlow below) — never colour,
  //     never the warp, by design decision (2026-11-13).
  // The live input spectrum: since step 2 of the redesign, a small ring at the very
  // centre of the sound screen, inside the vector ring (src/views/sound/sound-visualization.js)
  soundVisualization: {
    fftSize: 4096, // latest ~85 ms at 48 kHz, not a scrolling history
    bands: 256,
    minHz: 40, // logarithmic bands, from the top clockwise around the ring
    maxHz: 16000,
    floorDb: -78,
    ceilingDb: -24,
    radius: 0.05, // fraction of the shorter side of the screen
    radialReach: 0.06, // maximum outward extension in the same units
  },

  // The sound screen (step 2 of DESIGN-two-screens.md, src/views/sound/sound-view.js).
  // Sizes are fractions of the screen's shorter side.
  soundScreen: {
    // The CLAP vector ring: one ray per dimension (512), in the order of
    // data/vector-ring.json (npm run build:ring). A ray points out where this voice is
    // higher than usual on that dimension, in where it is lower.
    // 2026-11-21: reach doubled (and the ring a little smaller to make room) so the
    // shape changes visibly from round to round.
    ringRadius: 0.16,
    rayReach: 0.12, // the length of a ray 2.4 "usual amounts" away from average
    // A new round's vector reshapes the ring over this long, easing in and out. A round
    // is 5 s, so with 4.5 the ring is almost always on its way to a new shape (2026-11-21).
    morphSeconds: 4.5,
    // A slow undulation on top of the real shape, so the ring keeps moving even when no
    // new vector comes (silence): broad waves travelling round it. In rayReach units;
    // 0 = off. driftSeconds: roughly how long one wave takes to go round.
    driftAmount: 0.16,
    driftSeconds: 14,
    // The bright outline follows the rays averaged with this many neighbours on each
    // side (the raw rays are drawn faintly underneath). 0 = no smoothing; higher =
    // fewer, broader bulges.
    smoothRays: 10,
    ghosts: 2, // faint outlines of the last rounds' shapes, so a change in the voice shows
    // Each ray's brightness rises and falls on its own cycle, out of step with its
    // neighbours (the ring's SIZE never follows the voice's loudness any more)
    breathMinSeconds: 1.8, // the quickest ray's cycle
    breathMaxSeconds: 5.5, // the slowest ray's cycle
    breathDepth: 0.75, // 0 = no breathing; 1 = a ray fades right out at the low point
    // The box of the sound now playing shows that sound, live: a waveform across the
    // middle and its spectrum as bars, mirrored (src/views/sound/sound-view.js)
    playingBoxWidth: 200, // at least this big, so there is room for it
    playingBoxHeight: 86,
    // The chosen sound's own vector (2026-11-24): the same kind of ring as the voice's,
    // same dimension order and scale, so the two shapes can be compared. It never
    // changes for a given sound, so it holds still (only its rays breathe).
    //   · behind the playing box, as a ring round it; chosenRingReach is its rays'
    //     length, as a fraction of its radius (which follows the box's size)
    //   · on the voice's ring, as a faint dashed gold outline of the same shape, at
    //     compareOutline opacity (0 = off): where the two outlines bulge together is
    //     where the voice and the sound agree
    chosenRingSize: 0.92, // its radius, as a fraction of the box's half-width (was ~1.1, a little smaller 2026-11-24)
    chosenRingReach: 0.32,
    chosenRingGrowSeconds: 1, // the ring grows out of its bare circle when the sound is chosen
    compareOutline: 0.55,
    // The candidate sounds. Each sound category has its own fixed direction around
    // the ring (the order of config/sound-categories.json, clockwise from the top), so
    // over time "rain lives up and to the right". The most similar candidate sits
    // closest to the ring, the least similar farthest out; size = chance of being drawn.
    nearest: 0.04, // the gap between the ring's usual outer edge and the closest box
    roundFadeSeconds: 1.2, // the last round's boxes and lines fade out over this
    maxEntryDelay: 0.6, // boxes of a new round appear one by one, within this many seconds
  },

  // The semantic screen (step 3 of DESIGN-two-screens.md, src/views/semantic/).
  // Sizes are fractions of the screen's shorter side.
  semanticScreen: {
    // The ring of words: each slot around the circle holds one word of what was said;
    // new words replace the oldest in turn. A word's ray is as long as its weight:
    // how similar it is to the chosen label (the local text model, also when the LLM
    // chose the label). The heaviest word gets a box.
    wordSlots: 24,
    // Only words Whisper heard in these languages go onto the ring (Whisper's own
    // language codes). In noise, Whisper often "hears" Korean, Japanese, Arabic… that
    // nobody said, and on the ring it looked like garbled text (2026-11-21). Add a
    // language here if visitors will speak it. [] = every language.
    ringLanguages: ["zh", "en"],
    ringRadius: 0.14,
    rayReach: 0.06, // the ray of the heaviest word on the ring (shorter since 2026-11-21: the words matter more)
    newWordSeconds: 0.18, // new words arrive one after another, this far apart (was 0.35: a long sentence took seconds to appear)
    // Words get white boxes, as visible as they are meaningful (0 = the least
    // meaningful word on the ring, 1 = the most, which is gold). Words below
    // wordBoxFrom get none; above it the opacity rises slowly (cubed), so most boxes
    // are faint, up to wordBoxMax for the strongest. Each round, a random wordBoxSkip
    // of the words get no box at all, and the rest each get a different faintness.
    // (Fewer and fainter since 2026-11-21: there were too many, too clear.)
    wordBoxFrom: 0.4,
    wordBoxMax: 0.6,
    wordBoxSkip: 0.35,
    // The image labels shown as boxes around the ring: the chosen one, plus a few of
    // the others — half from the top of the local ranking, half at random, so most
    // lines mean something and a few are surprises. (4 looked too sparse, 2026-11-20.)
    otherLabels: 9,
    labelFadeSeconds: 0.5, // the last round's label boxes fade out over this (short, so two rounds' boxes don't pile up)
    // The chosen label's box shows the chosen image, small, below its text, cropped to
    // fit (2026-11-24). The box is at least this big, to make room for it.
    chosenBoxWidth: 150,
    chosenBoxHeight: 104,
    thumbnailOpacity: 0.92,
    // The new image spreads out from the chosen label's box, over transitionSeconds
    // (under visuals); its edge is broken up by the dissolve grid's noise
    spreadRoughness: 0.12,
  },

  visuals: {
    // The dissolve from one image to the next: a grid-cell "break apart", not an
    // even fade. Cells reveal in a scattered order; mismatch scrambles that order
    // further, so an image that fits badly arrives more chaotically. Its own
    // grid (dissolveGrid), always fine and NOT scaled by mismatch, so even a very
    // mismatched image arrives in small, quick pieces rather than big slow ones.
    transitionSeconds: 1.6,
    dissolveGrid: 9,

    // How long mismatch takes to glide (most of the way, ~63%) to a new value,
    // instead of jumping: when a new image arrives, and when a new sound changes how
    // well the image on screen fits (that happens every round, independently of the
    // image). Added 2026-11-20; before, both made the look change in one frame.
    mismatchEaseSeconds: 0.6,

    // How long, after a dissolve finishes, the busiest effects take to ease down
    // to their resting level (restActivity — see below), and how low that resting
    // level is. 2026-11-13: without this the piece looked busy and unclear almost
    // all the time, whatever was actually chosen; now a visitor gets a proper,
    // readable look at each image, and things only properly churn right as a new
    // one arrives (or when the pairing is a genuinely bad one — see mismatch above).
    settleSeconds: 2.5,
    restActivity: 0.3,

    // The "look" grid the picture is read through while it's on screen (separate
    // from the dissolve's own grid, above). A cell's size grows from gridFine
    // (fine, almost invisible) to gridCoarse (a visible block) as mismatch rises.
    // The grid itself is bent by a slow drift rather than being a rigid
    // checkerboard, so it never looks mechanical.
    gridFine: 1.2,
    gridCoarse: 24,

    // How hard each effect pushes, all measured at mismatch = 1 AND full activity
    // (at mismatch 0, or once things have settled, they are much weaker — see
    // restActivity above). jitterAmount nudges each grid cell sideways;
    // glitchAmount triggers small rectangular patches that shift, like a
    // corrupted block in a video signal; scanlineAmount is the opposite — a clean
    // technical texture that is strongest at mismatch 0 and fades OUT as
    // mismatch rises.
    warpAmount: 0.08, // liquid warp: a slow drift pulling the image, mismatch-only
    aberrationAmount: 0.012, // chromatic aberration (red/blue pulled apart)
    invertAmount: 0.5, // colour pushed toward inverted, plus occasional glitch flashes
    saturateAmount: 0.55, // colour pushed toward high saturation
    glitchAmount: 0.55,
    jitterAmount: 0.5,
    scanlineAmount: 0.5,

    // An offset, glowing trace along the edges of things in the photo (a tree
    // line, a horizon) — like a double exposure that has drifted apart. Off at
    // mismatch 0; both how visible it is and how far it drifts grow with
    // mismatch. Traces an edge rather than hiding it, so unlike the effects
    // above it stays mostly present even once things have settled.
    outlineAmount: 0.5,
    outlineOffset: 0.02,
    outlineThreshold: 0.12, // how strong an edge has to be before it's traced (lower = traces more)

    // Volume's one allowed role: a LIGHT touch of extra jitter and brightness.
    // Never colour, never the warp (decided 2026-11-13).
    energyJitter: 0.15,
    energyGlow: 0.08,

    // Always on, regardless of mismatch: zoom (each image zooms in slowly so it
    // never looks frozen), vignette (darker corners), grain (a little static).
    zoomPerImage: 0.05, // 5% zoom in over zoomSeconds
    zoomSeconds: 25,
    vignette: 0.4,
    grain: 0.03,

    // Below quietDb the voice counts as silent (energy 0), above loudDb as loud
    // (energy 1). attack/release: how fast energy rises/falls each frame — rising
    // fast, falling slowly, so it doesn't flicker.
    quietDb: -60,
    loudDb: -22,
    attack: 0.25,
    release: 0.04,

    // Images bigger than this (on their longest side) are shrunk once when
    // loaded. Only the two images actually on screen (current and the one it's
    // dissolving over) are ever kept in graphics memory — see src/views/semantic/semantic-view.js
    // — so a whole visit's worth of images never piles up. 1 = one shader pixel
    // per CSS pixel; higher looks sharper but costs the graphics card more.
    maxImageSide: 2048,
    pixelDensity: 1,
  },

  // Phrases Whisper tends to "hear" in noise or silence (step 5, see src/semantic/transcript.js).
  // A transcript that is exactly one of these (ignoring case and punctuation) is dropped.
  // Add any others you notice in the debug panel.
  speechIgnore: [
    "you",
    "thank you",
    "thank you.",
    "thanks for watching",
    "thank you for watching",
    "bye",
    "subtitles by the amara.org community",
    "谢谢观看",
    "謝謝觀看",
    "字幕由Amara.org社区提供",
    "请不吝点赞 订阅 转发 打赏支持明镜与点点栏目",
    "ご視聴ありがとうございました",
    "продолжение следует",
  ],

  // CLAP's compressed 8-bit version. Must match tools/lib/clap.mjs, which made
  // data/sound-vectors.json, or live and precomputed vectors won't be comparable (step 4)
  soundDtype: "q8",

  // How the next nature sound is chosen (step 4). See src/sound/sound-choice.js.
  // CLAP ranks all library sounds by similarity to the voice. Sounds that just played
  // rest for a while; sounds not heard for a long time get a small bonus; then one of
  // the best few is drawn at random, the better the score the likelier.
  // "Rounds" here count rounds with a voice (quiet rounds don't count).
  soundChoice: {
    // Centering (see README): compare how this voice differs from an average voice
    // with how each sound differs from an average nature sound. Without it, every
    // voice matches the same one or two "voice-like" sounds. Set to false to compare.
    centering: true,
    // The average voice starts from tools/reference-voices and drifts towards the
    // current visitor: each voice round moves it this far (0 = never, 1 = jump).
    // So a visitor's own changes in tone stand out, not just "being a voice".
    voiceAdapt: 0.15,
    pool: 15, // only the 15 sounds closest to the voice can be chosen at all
    candidates: 5, // of those, the best 5 that are not resting are drawn from
    restRounds: 8, // after playing, a sound rests for 8 rounds (about 40 s of talking)
    freshBonus: 0.03, // a sound not heard for a long time (or ever) gets up to +0.03…
    freshRounds: 24, // …the full bonus after 24 rounds (about 2 min); less if heard more recently
    // How random the final draw is. Two candidates 0.02 apart: the better one is
    // about 2.7× as likely at 0.02. Smaller = almost always the best; larger = more even.
    temperature: 0.02,
  },

  // Playback of the nature sounds (step 4).
  // Each chosen sound fades in and repeats its 5-second clip with no gap, until the
  // next sound is chosen (it then fades out under the new one: a crossfade) or the
  // screens go dark (2026-11-24; before, each played 10 s and stopped, leaving silence
  // whenever a round chose no new sound).
  playback: {
    textureMix: 0.35, // maximum granular wet mix at mismatch 1; at least 65% remains dry
    volume: 0.7, // 0 = silent, 1 = full (two sounds overlap while crossfading, so leave some room)
    fadeSeconds: 2.5, // fade-in of each new sound
    fadeOutSeconds: 3.2, // fade-out of the sound before it, starting as the new one fades in
  },
};
