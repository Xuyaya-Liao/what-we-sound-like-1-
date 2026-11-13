// main.js: the main entry point of the piece. Every part is plugged in from here.
//   step 0: placeholder visuals (p5); step 10 moved them to src/visuals/ (shaders)
//   step 1: asset library
//   step 3: input — microphone or recording, cut into 5-second segments
//   step 4: sound path — CLAP → closest nature sound → overlapping, fading layers
//   step 5: meaning path (local) — Whisper → text → closest label (text embedding)
//   step 6: meaning path (LLM) — the LLM chooses the label; the local one is the fallback
//   step 7: images — the label's next image (shuffle bag) is chosen
//   step 8: timing and stability — how long each round takes, nothing piles up
//   step 9: experiment log — every round's results, downloadable as JSON or CSV
//   step 10: visuals v2 — a shader driven by "mismatch": how well the chosen sound's
//            category and the chosen image's label agree (see src/visuals/)
//   step 10 also includes the embedding HUD — a 2D overlay tracing each round's
//            real candidates and scores, computer-vision-debug style (src/visuals/hud.js)
// The two paths run at the same time, each in its own Web Worker.

// import: take things other files export.
// This is why index.html says type="module": a plain <script> cannot use import.
import { CONFIG } from "./config.js";
import { loadLibrary, loadSoundCategories } from "./library.js";
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
import { createVisuals } from "./visuals/visuals.js";

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
    visuals: CONFIG.visuals,
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
  soundCategory: undefined, // the most recently chosen sound's category, e.g. "rain" (step 4)
  mismatch: 0.25, // how well soundCategory and label agree, 0–1; read live, every frame (step 10)
  soundId: undefined, // the selected clip within the sound category
  soundCandidates: undefined, // this round's CLAP ranking, for the embedding HUD (step 10)
  labelCandidates: undefined, // this round's local label ranking, for the embedding HUD (step 10)
};

// soundCategory, label → 0 (agree) … 1 (don't), from the text model comparing their
// descriptions (built once the labels are loaded — see matchLookup below). Until
// then, or for an id it has never seen, a neutral middle value.
let match = () => 0.5;
let matchCategories = [];
function createMatchLookup(matrix) {
  if (!matrix) return () => 0.5;
  const categoryIndex = new Map(matrix.categories.map((id, i) => [id, i]));
  const labelIndex = new Map(matrix.labels.map((id, i) => [id, i]));
  return (categoryId, labelId) => {
    const i = categoryIndex.get(categoryId);
    const j = labelIndex.get(labelId);
    return i === undefined || j === undefined ? 0.5 : matrix.values[i][j];
  };
}

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

// ---- Visuals (steps 7 and 10) ----
// Everything you see lives in src/visuals/: the p5 sketch (visuals.js) and the shader
// that draws every pixel (shaders/image.frag). main.js only says which image to show
// (visuals.showPicture) and keeps `live.levelDb` and `live.mismatch` up to date; the
// sketch reads those by itself. To redesign the look, start there — or try ideas
// first in experiments/visuals-lab/, a page with sliders that touches none of this.
const visuals = createVisuals(document.getElementById("stage"), live);

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

  // The text model needs the label table to compare transcripts with, and (step 10)
  // the sound-category table, to build the mismatch lookup used by the visuals.
  // (The worker waits for its models to load before it starts on this.)
  const soundCategories = await loadSoundCategories();
  speechModel
    .call("labels", { labels: library.labels, soundCategories })
    .then(({ matchMatrix }) => {
      modelState["Text model"] = "ready";
      match = createMatchLookup(matchMatrix);
      matchCategories = matchMatrix?.categories ?? [];
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
    const { otherMatches, ...selection } = choice;
    round.sound({ ...selection, ms });
    live.soundCategory = choice.chosen.sound.category; // for the visuals' mismatch (step 10)
    live.soundId = choice.chosen.sound.id;
    // Keep eligible clips first, then fill the HUD with other close matches.
    live.soundCandidates = [...choice.candidates, ...otherMatches].map(({ sound, score, probability }) => ({
      id: sound.id,
      category: sound.category,
      score,
      weight: probability ?? 0,
    }));
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
    live.labelCandidates = ranking; // for the embedding HUD (step 10)
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

// ---- Images (step 7) and the visuals' mismatch (step 10) ----
// The label's next image (from its shuffle bag) dissolves in over the current one.
// How that dissolve looks, and the look of the image while it's on screen, both
// come from "mismatch": how well the sound most recently chosen (live.soundCategory
// — not necessarily chosen on this exact round, since the two paths run independently,
// but almost always close in time) agrees with this label. live.mismatch is read
// live, every frame, by the visuals — see src/visuals/visuals.js. This is also where
// the embedding HUD (step 10) gets this round's story: the candidates each path
// ranked, which ones won, and the mismatch between them.
// counted: include the time in the session summary (not for typed sentences)
async function showImage(label, round, since, counted) {
  const choice = imageChooser?.next(label);
  if (!choice) return round.note(`no images for “${label}”`, "speech");
  live.mismatch = 1 - match(live.soundCategory, label);
  round.image({ ...choice, mismatch: live.mismatch });
  live.image = choice.image;
  // Before any audio result, show category associations from the match table.
  // These scores describe the image label's associations, not a CLAP ranking.
  const soundCandidates = live.soundCandidates ?? matchCategories
    .map((category) => ({ id: category, category, score: match(category, label), weight: 0, association: true }))
    .sort((a, b) => b.score - a.score);
  visuals.showAnalysis({
    soundCandidates,
    labelCandidates: live.labelCandidates ?? [],
    chosenSoundId: live.soundId,
    chosenLabel: label,
    mismatch: live.mismatch,
    match, // so the HUD can colour every candidate pair's own real mismatch, not just the chosen one
  });
  try {
    await visuals.showPicture(choice.image.file);
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
