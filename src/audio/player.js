// player.js: plays the chosen nature sounds as overlapping, fading layers.
//
// Every chosen sound fades in and then repeats its clip for as long as it is the
// latest one, with no gap (2026-11-24; before, each played for 10 s and stopped, so a
// round without a new sound left silence). When the next sound is chosen, it fades in
// while the one before fades out under it (a crossfade):
//
//   volume       new sound chosen
//     1 |      ________|
//       |    /         |\        old
//     0 |___/          | \___
//                      |  /‾‾‾‾‾‾‾‾  new, repeating until the next one
//
// stop() (the dark screen, a recording ending) fades everything out. Nothing ever
// switches abruptly.
//
//   each sound ──▶ granular texture ──▶ its own fade envelope ──▶ master ──▶ speakers

import { CONFIG } from "../config.js";

const EDGE_SECONDS = 0.03; // a 30 ms fade at both ends of each clip, so the repeat doesn't click
const STOP_SECONDS = 1.5; // how fast everything fades when playback is stopped
const KEEP_DECODED = 40; // decoded clips kept in memory (~1 MB each), the most recently used

// Equal-power fade shapes: two overlapping sounds keep a steady overall loudness
// (a straight-line fade would dip in the middle).
const FADE_STEPS = 64;
const FADE_IN = Float32Array.from({ length: FADE_STEPS }, (_, i) => Math.sin(((i / (FADE_STEPS - 1)) * Math.PI) / 2));
// Smoothstep reaches zero with a flat slope, so the tail does not cut off sharply.
const FADE_OUT = Float32Array.from({ length: FADE_STEPS }, (_, i) => {
  const t = i / (FADE_STEPS - 1);
  return 1 - t * t * (3 - 2 * t);
});

export async function createPlayer(context) {
  await context.audioWorklet.addModule(new URL("./texture-worklet.js", import.meta.url));
  let currentMismatch = 0;
  let generation = 0;
  const master = context.createGain();
  master.gain.value = CONFIG.playback.volume;
  master.connect(context.destination);

  // file → decoded sound, so a clip heard again isn't downloaded and decoded again.
  // A decoded 5-second clip takes about 1 MB of memory; keeping all 181 would grow to
  // ~180 MB over a long session, so only the most recently used ones are kept (step 8).
  const buffers = new Map();
  const playing = new Set(); // { source, texture, gain } of every sound still sounding

  function load(file) {
    let decoding = buffers.get(file);
    if (decoding) {
      buffers.delete(file); // re-add below, so the Map's order stays "least recently used first"
    } else {
      decoding = fetch(file)
        .then((response) => response.arrayBuffer())
        .then((bytes) => context.decodeAudioData(bytes))
        .then(softenEdges);
      decoding.catch(() => buffers.delete(file)); // allow a retry after a failed download
    }
    buffers.set(file, decoding);
    // Forget the least recently used. (A sound still playing keeps its own copy until it ends.)
    while (buffers.size > KEEP_DECODED) buffers.delete(buffers.keys().next().value);
    return decoding;
  }

  // Jumping from the end of a clip straight back to its start makes a click, because
  // the two sample values don't line up. A tiny fade at both ends hides it.
  function softenEdges(buffer) {
    const edge = Math.min(Math.round(EDGE_SECONDS * buffer.sampleRate), Math.floor(buffer.length / 2));
    for (let channel = 0; channel < buffer.numberOfChannels; channel++) {
      const samples = buffer.getChannelData(channel);
      for (let i = 0; i < edge; i++) {
        const fade = i / edge;
        samples[i] *= fade;
        samples[samples.length - 1 - i] *= fade;
      }
    }
    return buffer;
  }

  return {
    setMismatch(value) {
      const mismatch = Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0;
      currentMismatch = mismatch;
      for (const { texture } of playing) {
        texture.parameters.get("mismatch").setTargetAtTime(mismatch, context.currentTime, 0.18);
      }
    },
    // Fades one sound in and keeps it repeating, while every sound already playing
    // fades out under it. Returns an AnalyserNode listening to this sound alone,
    // after its fades (for the sound screen's playing box), or undefined if playback
    // was stopped (or a newer sound was asked for) while the file loaded.
    async play(file) {
      const ticket = ++generation;
      const buffer = await load(file);
      if (ticket !== generation) return;
      const fade = CONFIG.playback.fadeSeconds;

      const source = context.createBufferSource();
      source.buffer = buffer;
      source.loop = true; // the clip repeats until the next sound replaces it
      const gain = context.createGain();
      gain.gain.value = 0; // silent until the fade-in begins
      // Process each voice before its envelope: granular tails fade with that voice.
      const texture = new AudioWorkletNode(context, "nature-texture", {
        channelCount: 2,
        channelCountMode: "explicit",
        outputChannelCount: [2],
        parameterData: { mismatch: currentMismatch, wet: CONFIG.playback.textureMix },
      });
      source.connect(texture).connect(gain).connect(master);
      // A tap after the envelope: what this sound looks like, as it is heard. It
      // leads nowhere (the browser still runs an analyser with nothing after it).
      const analyser = context.createAnalyser();
      analyser.fftSize = 2048;
      analyser.smoothingTimeConstant = 0.7;
      gain.connect(analyser);

      // Fade in; no end is scheduled: it repeats until the next sound or stop().
      // The sounds already playing fade out from the same moment: a crossfade.
      const start = context.currentTime + 0.05;
      for (const other of playing) fadeAway(other, start, CONFIG.playback.fadeOutSeconds);
      gain.gain.setValueCurveAtTime(FADE_IN, start, fade);
      source.start(start);

      const sound = { source, texture, gain };
      playing.add(sound);
      source.onended = () => {
        source.disconnect();
        texture.disconnect();
        gain.disconnect();
        playing.delete(sound);
      };
      return analyser;
    },

    // Fades out everything that is playing (the dark screen, a recording ending).
    stop() {
      generation++;
      const now = context.currentTime;
      for (const sound of playing) fadeAway(sound, now, STOP_SECONDS);
    },
  };

  // Fades one sound out from wherever its volume is at `from` (even halfway through
  // its fade-in), over `seconds`, then stops it. A sound already fading out keeps
  // its own, earlier end.
  function fadeAway(sound, from, seconds) {
    const { source, gain } = sound;
    if (sound.endsAt !== undefined && sound.endsAt <= from + seconds) return;
    const now = context.currentTime;
    from = Math.max(from, now);
    // Freeze the envelope where it is… (older browsers: cancel, then pin the current value)
    const current = gain.gain.value;
    if (gain.gain.cancelAndHoldAtTime) {
      gain.gain.cancelAndHoldAtTime(now);
    } else {
      gain.gain.cancelScheduledValues(now);
      gain.gain.setValueAtTime(current, now);
    }
    // …and fade from there, with the same smooth shape as always
    gain.gain.setValueCurveAtTime(FADE_OUT.map((step) => step * current), from + 0.001, seconds);
    sound.endsAt = from + 0.001 + seconds;
    source.stop(sound.endsAt + 0.02);
  }
}
