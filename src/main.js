// main.js: the main entry point of the piece. Every part is plugged in from here.
//   step 0: placeholder visuals (p5)
//   step 1: asset library
//   step 3: input — microphone or recording, cut into 5-second segments
//   step 4: sound path — CLAP → closest nature sound → overlapping, fading layers
//   step 5: meaning path (local) — Whisper → text → closest label (text embedding)
//   step 6: meaning path (LLM) — the LLM chooses the label; the local one is the fallback
//   step 7: images — the label's next image (shuffle bag) fades in
//   step 8: timing and stability — how long each round takes, nothing piles up
//   step 9: experiment log — every round's results, downloadable as JSON or CSV
// The two paths run at the same time, each in its own Web Worker.

// import: take things other files export.
// This is why index.html says type="module": a plain <script> cannot use import.
import { CONFIG } from "./config.js";
import { loadLibrary } from "./library.js";
import { listMicrophones, NO_SIGNAL_DB, startCapture } from "./audio/capture.js";
import { prepareSegment } from "./audio/resample.js";
import { createPlayer } from "./audio/player.js";
import { createSoundChooser, loadSoundVectors } from "./sound/sound-choice.js";
import { cleanTranscript } from "./semantic/transcript.js";
import { apiKey, createLlmLabeller, llmSwitchedOn } from "./semantic/llm-label.js";
import { createImageChooser } from "./image/image-choice.js";
import { createWorkerClient } from "./workers/worker-client.js";
import { createDebugPanel } from "./ui/debug-panel.js";
import { createSessionStats } from "./session-stats.js";
import { createRoundLog, downloadText } from "./log/round-log.js";

const startScreen = document.getElementById("start-screen");
const startButton = document.getElementById("start-button");
const recordingInput = document.getElementById("recording-input");
const statusLine = document.getElementById("status");
const debug = createDebugPanel();
const stats = createSessionStats(); // rounds, timings, skips (step 8)
const showStats = () => debug.setStats(stats.summary());

// ---- Experiment log (step 9) ----
// Every round's results are written down (src/log/round-log.js). The debug panel has
// a tag box (for the reading experiment) and buttons to download the log.
const log = createRoundLog();
debug.setupLog({
  onTag: (text) => log.setTag(text),
  onJson: () => downloadText(log.toJson(settingsForLog()), `${logFileName()}.json`, "application/json"),
  onCsv: () => downloadText(log.toCsv(), `${logFileName()}.csv`, "text/csv"),
  onClear() {
    log.clear();
    debug.setLogCount(0);
  },
});

// e.g. "wwsl-log-2026-11-12-1530"
function logFileName() {
  const now = new Date();
  const two = (value) => String(value).padStart(2, "0");
  return `wwsl-log-${now.getFullYear()}-${two(now.getMonth() + 1)}-${two(now.getDate())}-${two(now.getHours())}${two(now.getMinutes())}`;
}

// The settings the log was recorded under, saved at the top of the JSON file
function settingsForLog() {
  return {
    whisper: modelState.Whisper,
    llm: llm ? CONFIG.llm.model : "off",
    roundSeconds: CONFIG.roundSeconds,
    listenSeconds: CONFIG.speech.listenSeconds,
    quietBelowDb: CONFIG.quietBelowDb,
    microphone: CONFIG.microphone,
    soundChoice: CONFIG.soundChoice,
    images: CONFIG.images,
  };
}

// Starts a log row for a round (or typed sentence) and returns the round's handle,
// which now fills in the debug panel and the log row together
function tracked(handle, start) {
  const round = log.track(handle, start);
  debug.setLogCount(log.count);
  return round;
}

// Values shared between the program and the visuals
const live = {
  levelDb: -Infinity, // loudness right now (updated ~25 times a second)
  said: "", // the last thing understood (step 5)
  label: undefined, // the label it points to, e.g. "still_water" (steps 5–6)
  image: undefined, // the image showing for that label (step 7)
};

let audioContext; // the browser's sound engine, shared by input and playback (created on Begin)
let player; // plays the nature sounds
let capture; // the running input, once started
let silentRounds = 0; // microphone rounds in a row with no signal at all
let soundChooser; // picks the nature sound, once the vectors are loaded
let llm; // asks the LLM for a label (step 6); stays undefined while the LLM is off
let imageChooser; // picks the image for a label (step 7)
let soundBusy = false; // true while CLAP is working on a segment
let speechBusy = false; // true while Whisper is working on a segment
let previousSpeech; // the last round's 16 kHz samples, so Whisper can hear 10 s (step 5)
let latestMeaning = 0; // numbers each sentence being understood, so an old one can't override a newer one (step 8)

// ---- p5 visuals ----
// The professor's examples use "global mode": you write function setup() / function draw() directly.
// Inside a module, p5 cannot find a setup written that way, so we use "instance mode":
// the whole sketch is one function, and p5 hands it a parameter called p.
// Everything you used to write directly, like createCanvas or background,
// is written here as p.createCanvas, p.background.
// Both modes can do exactly the same things; this one just adds "p." in front.
let showPicture; // showPicture(file): fade to this image (step 7). Set by the sketch below.

const sketch = (p) => {
  let energy = 0; // 0 = silence, 1 = loud voice, smoothed so it doesn't flicker
  let current; // the image fading in (or already shown): { picture, since }
  let previous; // the one it is fading in over
  let requests = 0; // counts showPicture calls, so a slow load can't replace a newer image

  // loadImage downloads and decodes the image; "await" waits until it's done
  showPicture = async (file) => {
    const ticket = ++requests;
    const picture = await p.loadImage(file);
    if (ticket !== requests) return; // a newer image was asked for meanwhile
    previous = current;
    current = { picture, since: p.millis() };
  };

  p.setup = () => {
    p.createCanvas(p.windowWidth, p.windowHeight);
    p.noStroke();
  };

  p.draw = () => {
    const target = p.constrain(p.map(live.levelDb, -60, -20, 0, 1), 0, 1);
    energy = p.lerp(energy, target, 0.15);
    p.background(12, 20, 19);

    // The images (step 7): the new one fades in over the old one, then the old one is dropped.
    // Step 10 replaces this simple fade with shaders.
    if (current) {
      const fade = Math.min(1, (p.millis() - current.since) / (CONFIG.images.fadeSeconds * 1000));
      if (previous) drawCover(previous, 1);
      drawCover(current, fade);
      if (fade === 1) previous = undefined;
    }

    // Placeholder: a few slowly breathing lights that swell when someone speaks.
    const t = p.millis() / 1000;
    for (let i = 0; i < 5; i++) {
      const x = p.width * (0.5 + 0.3 * Math.sin(t * 0.13 + i * 1.7));
      const y = p.height * (0.5 + 0.25 * Math.cos(t * 0.11 + i * 2.3));
      const size = Math.min(p.width, p.height) * (0.35 + 0.1 * Math.sin(t * 0.5 + i)) * (1 + energy * 0.6);
      p.fill(120, 200, 170, 18 + energy * 40);
      p.circle(x, y, size);
    }
  };

  // Draws an image so it covers the whole canvas (cropping the sides or the top and
  // bottom, never stretching), at a given opacity (0–1). It also zooms in very
  // slowly (+4% over 20 s), so a still picture doesn't look frozen.
  function drawCover({ picture, since }, opacity) {
    const zoom = 1 + 0.04 * Math.min(1, (p.millis() - since) / 20000);
    const scale = Math.max(p.width / picture.width, p.height / picture.height) * zoom;
    const w = picture.width * scale;
    const h = picture.height * scale;
    // drawingContext is the browser's own canvas; globalAlpha sets the opacity of what is drawn next
    p.drawingContext.globalAlpha = opacity;
    p.image(picture, (p.width - w) / 2, (p.height - h) / 2, w, h);
    p.drawingContext.globalAlpha = 1;
  }

  // When the window is resized, resize the canvas with it
  p.windowResized = () => {
    p.resizeCanvas(p.windowWidth, p.windowHeight);
  };
};

// window.p5 comes from p5.min.js, which index.html loads with a <script> tag
new window.p5(sketch, document.getElementById("stage"));

// ---- Models (step 4) ----
// Start downloading the models right away, while the visitor reads the start screen.
// They run in Web Workers (see workers/worker-client.js), so the visuals never freeze.
// The state of each model, shown in the debug panel: "CLAP ready · Whisper 42% · Text model …"
const modelState = { CLAP: "loading…", Whisper: "loading…", "Text model": "loading…" };
const downloads = {}; // model → { loaded, total }: bytes downloaded so far, out of how many
let libraryReady = false; // the asset list and the sound vectors are loaded
let loadingFailed; // why loading failed, if it did
let everReady = false; // everything has been ready once (Begin has been enabled)

function showModels() {
  const text = Object.entries(modelState).map(([name, state]) => `${name} ${state}`).join(" · ");
  debug.setModels(text);
  showLoading();
}

// ---- Loading screen ----
// One bar for all three models together, measured in bytes, so a big model counts
// for more than a small one. Begin (and choosing a recording) stays disabled until
// every model is ready. The first visit downloads a few hundred MB; after that the
// browser keeps the models, and the bar fills in a few seconds.
const loadingBar = document.getElementById("loading");
const loadingFill = document.getElementById("loading-fill");

function showLoading() {
  if (everReady) return; // the start screen has moved on; nothing to show here any more

  if (loadingFailed) {
    loadingBar.hidden = true;
    statusLine.textContent = `Could not load: ${loadingFailed}. Check the internet connection and reload the page.`;
    return;
  }

  const allReady = libraryReady && Object.values(modelState).every((state) => state.startsWith("ready"));
  if (allReady) {
    everReady = true;
    loadingFill.style.width = "100%";
    loadingBar.hidden = true;
    startButton.disabled = false;
    recordingInput.disabled = false;
    statusLine.textContent = testRecording ? `Ready · test input: ${testRecording}` : "Ready.";
    return;
  }

  // Each model tells its size once its download starts. Until all three have,
  // the total isn't known yet, and a percentage would jump around.
  const sizes = Object.values(downloads);
  if (sizes.length < Object.keys(modelState).length) {
    statusLine.textContent = "Loading…";
    return;
  }
  const loaded = sizes.reduce((sum, size) => sum + size.loaded, 0);
  const total = sizes.reduce((sum, size) => sum + size.total, 0);
  // Never show 100% before Begin works (after downloading, the models still have to
  // start), and never move backwards
  shownPercent = Math.max(shownPercent, Math.min(99, (100 * loaded) / total));
  loadingFill.style.width = `${shownPercent}%`;
  loadingBar.setAttribute("aria-valuenow", Math.round(shownPercent));

  const megabytes = (bytes) => Math.round(bytes / 1e6);
  statusLine.textContent =
    loaded < total
      ? `Loading the listening models · ${megabytes(loaded)} of ${megabytes(total)} MB`
      : "Starting the models…";
}
let shownPercent = 0; // how full the bar is

const onProgress = ({ model, progress, loaded, total }) => {
  modelState[model] = `${Math.round(progress)}%`;
  if (Number.isFinite(loaded) && Number.isFinite(total)) downloads[model] = { loaded, total };
  showModels();
};

// A test recording can be given in the address bar (see "Input" below)
const testRecording = new URLSearchParams(location.search).get("input");
showModels();

const soundModel = createWorkerClient(new URL("./workers/sound-worker.js", import.meta.url), { onProgress });
soundModel
  .call("load")
  .then(() => (modelState.CLAP = "ready"))
  .catch((error) => {
    modelState.CLAP = `failed: ${error.message}`;
    loadingFailed ??= `CLAP (${error.message})`;
  })
  .finally(showModels);

const speechModel = createWorkerClient(new URL("./workers/speech-worker.js", import.meta.url), { onProgress });
speechModel
  .call("load")
  .then(({ whisper }) => (modelState.Whisper = `ready (${whisper})`)) // e.g. "ready (small · GPU)"
  .catch((error) => {
    modelState.Whisper = `failed: ${error.message}`;
    loadingFailed ??= `Whisper (${error.message})`;
  })
  .finally(showModels);

// ---- Asset library (steps 1, 4 and 5) ----
// try / catch: if loading fails (for example the build script was never run),
// show the problem on the page instead of silently breaking.
try {
  const library = await loadLibrary();
  soundChooser = createSoundChooser(await loadSoundVectors(library));
  imageChooser = createImageChooser(library.images, CONFIG.images.recent);
  libraryReady = true;

  // The LLM (step 6), only when switched on (config.js, or ?llm=on in the address bar)
  if (llmSwitchedOn()) llm = createLlmLabeller(library.labels);
  showLlm();

  // The text model needs the label table to compare transcripts with.
  // (The worker waits for its models to load before it starts on this.)
  speechModel
    .call("labels", { labels: library.labels })
    .then(() => {
      modelState["Text model"] = "ready";
      debug.enableTyping((text) => understand(text, tracked(debug.addTyped(text), { input: "typed", transcript: text })));
    })
    .catch((error) => {
      modelState["Text model"] = `failed: ${error.message}`;
      loadingFailed ??= `Text model (${error.message})`;
    })
    .finally(showModels);
} catch (error) {
  loadingFailed ??= error.message;
  showLoading();
  debug.setWarning(error.message);
  console.error(error);
}

// ---- Input (step 3) ----
// For repeatable tests, a recording can also be given in the address bar:
//   http://localhost:5510/?input=test-audio/en-water-storm.wav
// Then "Begin" plays that file instead of opening the microphone.
// Add &loop to play it over and over, for long stability tests (step 8).
// Begin is enabled by showLoading() above, once every model is ready.

startButton.onclick = () => begin(testRecording ?? undefined);
recordingInput.onchange = () => {
  if (recordingInput.files[0]) begin(recordingInput.files[0]);
  recordingInput.value = ""; // so choosing the same file again still counts as a change
};

// recording: a file or URL to play instead of the microphone (optional)
// deviceId: which microphone to use (optional)
async function begin(recording, deviceId) {
  capture?.stop(); // stop whatever input was running before
  startButton.disabled = true;
  silentRounds = 0;
  previousSpeech = undefined; // don't let Whisper hear the end of the last input
  debug.setWarning("");
  statusLine.textContent = recording ? "Loading the recording…" : "Waiting for microphone permission…";

  // Browsers only allow sound after a click, so the sound engine is created here, on Begin.
  audioContext ??= createAudioContext();
  await audioContext.resume();
  player ??= createPlayer(audioContext);
  soundChooser?.reset(); // a new visitor: start again from the reference voice
  stats.reset();
  showStats();

  try {
    const loop = new URLSearchParams(location.search).has("loop");
    capture = await startCapture({ context: audioContext, recording, deviceId, loop, onSegment, onLevel, onEnd });
  } catch (error) {
    console.error(error);
    capture = undefined;
    statusLine.textContent = explainStartError(error);
    startButton.disabled = false;
    return;
  }

  startScreen.hidden = true;
  debug.show();
  debug.setInput(capture.label, capture.sampleRate);

  if (capture.microphone) {
    // Offer every microphone the browser can see; picking another restarts the input with it.
    const microphones = await listMicrophones();
    debug.setMicrophones(microphones, capture.microphone.deviceId, (id) => begin(undefined, id));
    // The system can mute the mic while we're running (mute key, another app taking it over)
    capture.microphone.track.onmute = () => debug.setWarning("The system has muted this microphone.");
    capture.microphone.track.onunmute = () => debug.setWarning("");
    // The device went away (e.g. Bluetooth headphones switched off)
    capture.microphone.track.onended = () =>
      debug.setWarning("This microphone was disconnected. Choose another one in the list above.");
  } else {
    debug.setMicrophones([]);
  }
}

// The browser's sound engine. If something outside the page interrupts it (the
// system switching audio devices, a phone call on some devices), it stops, and with
// it the microphone input. Try to start it again straight away (step 8).
function createAudioContext() {
  const context = new AudioContext();
  context.onstatechange = () => {
    if (context.state === "running" || !capture) return; // running, or nothing to keep going
    debug.setWarning(`The sound engine stopped (${context.state}). Restarting it…`);
    context
      .resume()
      .then(() => debug.setWarning(""))
      .catch(() => debug.setWarning("The sound engine stopped. Click Begin again."));
  };
  return context;
}

function onLevel(db) {
  live.levelDb = db;
  debug.setLevel(db);
}

// Called every 5 seconds with a new segment.
async function onSegment(segment) {
  const cutAt = performance.now(); // the moment the segment was cut: every timing counts from here
  const prepared = await prepareSegment(segment); // 48 kHz for CLAP, 16 kHz for Whisper
  const prepMs = Math.round(performance.now() - cutAt);
  const round = tracked(
    debug.addRound({
      ...segment,
      prepMs,
      onPlay: () => playSamples(prepared.sound, CONFIG.soundSampleRate),
    }),
    {
      input: capture?.label,
      round: segment.index + 1,
      startSec: segment.startSec,
      levelDb: Number.isFinite(segment.levelDb) ? Math.round(segment.levelDb * 10) / 10 : null,
      quiet: segment.quiet,
    },
  );
  stats.round(segment.quiet);
  showStats();

  checkForNoSignal(segment);
  const listening = listeningWindow(prepared.speech, segment.quiet);
  if (segment.quiet) return round.note("quiet: no new sound (the last one fades out on its own)");

  // Both paths at once: "how it sounds" (this 5 s) and "what it says" (the last 10 s)
  await Promise.all([soundPath(prepared.sound, round, cutAt), speechPath(listening, round, cutAt)]);
}

// Records how long a path took, in the round's block and in the session summary
function took(path, round, since, { counted = true } = {}) {
  const ms = performance.now() - since;
  round.took(path, ms);
  if (counted) stats.took(path, ms);
  showStats();
}

// What Whisper hears this round: the previous round + this one, 10 s in all.
// A word cut in half at the boundary between two rounds is then heard whole.
// A quiet previous round is left out: silence only invites Whisper to make things up.
function listeningWindow(samples, quiet) {
  const previous = previousSpeech;
  previousSpeech = quiet ? undefined : samples;
  if (!previous || CONFIG.speech.listenSeconds <= CONFIG.roundSeconds) return samples;

  const joined = new Float32Array(previous.length + samples.length);
  joined.set(previous, 0);
  joined.set(samples, previous.length);
  return joined;
}

// ---- Sound path (step 4) ----
// 5 s at 48 kHz → CLAP → choose a nature sound → play it
async function soundPath(samples, round, cutAt) {
  if (!soundChooser) return round.note("sound library not loaded");
  if (soundBusy) {
    stats.skip("CLAP");
    return round.note("CLAP still busy with the previous round: skipped");
  }

  soundBusy = true;
  try {
    const { vector, ms } = await soundModel.call("embed", { samples });
    const choice = soundChooser.choose(vector);
    round.sound({ ...choice, ms });
    await player.play(choice.chosen.sound.file); // 10 s, fading in over whatever is still playing
    took("sound", round, cutAt);
    debug.setNowPlaying(choice.chosen.sound);
  } catch (error) {
    console.error(error);
    round.note(`sound path failed: ${error.message}`);
  } finally {
    soundBusy = false;
  }
}

// ---- Meaning path (step 5) ----
// the last 10 s at 16 kHz → Whisper → text (in the language spoken) → closest label
async function speechPath(samples, round, cutAt) {
  if (speechBusy) {
    stats.skip("Whisper");
    return round.note("Whisper still busy with the previous round: skipped", "speech");
  }

  // Only Whisper itself counts as busy. Waiting for the LLM (up to 4 s) happens
  // after this, so a slow answer never makes the next round's Whisper skip.
  speechBusy = true;
  let text;
  try {
    const heard = await speechModel.call("transcribe", { samples });
    text = cleanTranscript(heard.text);
    round.speech({ ...heard, text, ignored: !text && heard.text ? heard.text : undefined });
  } catch (error) {
    console.error(error);
    round.note(`meaning path failed: ${error.message}`, "speech");
  } finally {
    speechBusy = false;
  }
  if (text) await understand(text, round, cutAt);
}

// Text → a label → an image. Used for speech and for sentences typed in the debug panel.
// First the local text model answers (fast, free). Then, if the LLM is on, it is
// asked too and its answer replaces the local one; if it fails, the local one stays.
// The image is chosen once the label is settled, so it changes only once per round.
// cutAt: when the segment was cut (undefined for a typed sentence)
async function understand(text, round, cutAt) {
  const since = cutAt ?? performance.now();
  // Sentences are numbered as they arrive. If a newer one is settled first (say this
  // one waited longer for the LLM), this one must not replace its image afterwards.
  const number = ++latestMeaning;
  let label;
  try {
    const { ranking, ms } = await speechModel.call("label", { text });
    round.label({ ranking, ms, source: "local" });
    label = ranking[0].id;
  } catch (error) {
    console.error(error);
    round.note(`labelling failed: ${error.message}`, "speech");
  }

  if (llm) {
    try {
      const answer = await llm.ask(text);
      round.llm(answer);
      label = answer.id;
    } catch (error) {
      round.note(`LLM failed: ${error.message} · keeping the local label`, "speech");
    } finally {
      if (llm.usage.calls) debug.setLlmUsage(llm.usage, CONFIG.llm.model);
    }
  }

  if (!label) return;
  if (number !== latestMeaning) return round.note("a newer sentence was understood first: image not changed", "speech");
  live.said = text;
  live.label = label;
  await showImage(label, round, since, cutAt !== undefined);
}

// ---- Images (step 7) ----
// The label's next image (from its shuffle bag) fades in over the current one.
// counted: include the time in the session summary (not for typed sentences)
async function showImage(label, round, since, counted) {
  const choice = imageChooser?.next(label);
  if (!choice) return round.note(`no images for “${label}”`, "speech");
  round.image(choice);
  live.image = choice.image;
  try {
    await showPicture(choice.image.file);
    took("image", round, since, { counted });
  } catch (error) {
    console.error(error);
    round.note(`image failed to load: ${choice.image.file}`, "speech");
  }
}

// The LLM line and key box in the debug panel
function showLlm() {
  debug.setLlm({
    on: Boolean(llm),
    model: CONFIG.llm.model,
    hasKey: Boolean(apiKey.get()),
    onKey(key) {
      apiKey.set(key);
      showLlm();
    },
    onForget() {
      apiKey.forget();
      showLlm();
    },
  });
}

// A real room is never perfectly silent. Two microphone rounds in a row of pure
// zeros means the browser is getting no signal from this device at all.
function checkForNoSignal(segment) {
  if (!capture?.microphone) return;
  silentRounds = segment.levelDb < NO_SIGNAL_DB ? silentRounds + 1 : 0;
  if (silentRounds === 2) {
    debug.setWarning(
      "No signal from this microphone (not even room noise). Check, in this order:\n" +
        "· the laptop's microphone mute key (often F4, F8 or F9, a crossed-out mic)\n" +
        "· Windows mute: Settings → System → Sound → Input → this microphone\n" +
        "· another microphone in the list above (not a Bluetooth headset)\n" +
        "· Settings → Privacy & security → Microphone allows apps",
    );
  } else if (silentRounds === 0) {
    debug.setWarning("");
  }
}

// When a recording finishes, fade the nature sound out and bring the start screen back.
function onEnd() {
  live.levelDb = -Infinity;
  debug.setLevel(-Infinity);
  player.stop();
  debug.setNowPlaying(undefined);
  statusLine.textContent = "The recording has finished.";
  startButton.disabled = false;
  startScreen.hidden = false;
}

// Plays a segment back, to check what was captured.
function playSamples(samples, sampleRate) {
  const buffer = audioContext.createBuffer(1, samples.length, sampleRate);
  buffer.copyToChannel(samples, 0);
  const source = audioContext.createBufferSource();
  source.buffer = buffer;
  source.connect(audioContext.destination);
  source.start();
}

function explainStartError(error) {
  if (error.name === "NotAllowedError") {
    return "Microphone access was blocked. Allow it from the icon in the address bar, or choose a recording.";
  }
  if (error.name === "NotFoundError") return "No microphone was found. Choose a recording instead.";
  return `Could not start: ${error.message}`;
}
