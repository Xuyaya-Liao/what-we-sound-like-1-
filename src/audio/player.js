// player.js: plays the chosen nature sounds as overlapping, fading layers.
//
// Every chosen sound plays once for CONFIG.playback.seconds (10 s: its 5-second clip
// twice), with a fade-in at the start and a fade-out at the end:
//
//   volume
//     1 |      ____________
//       |    /              \
//     0 |___/                \___
//         0  2.5          7.5  10 s
//
// A new sound starts every 5 seconds, so it fades in while the previous one is still
// playing, and the previous one fades out under it. Nothing ever switches abruptly.
//
//   each sound ──▶ its own volume (the envelope above) ──▶ master volume ──▶ speakers

import { CONFIG } from "../config.js";

const EDGE_SECONDS = 0.03; // a 30 ms fade at both ends of each clip, so the repeat doesn't click
const STOP_SECONDS = 1.5; // how fast everything fades when playback is stopped
const KEEP_DECODED = 40; // decoded clips kept in memory (~1 MB each), the most recently used

// Equal-power fade shapes: two overlapping sounds keep a steady overall loudness
// (a straight-line fade would dip in the middle).
const FADE_STEPS = 64;
const FADE_IN = Float32Array.from({ length: FADE_STEPS }, (_, i) => Math.sin(((i / (FADE_STEPS - 1)) * Math.PI) / 2));
const FADE_OUT = FADE_IN.slice().reverse();

export function createPlayer(context) {
  const master = context.createGain();
  master.gain.value = CONFIG.playback.volume;
  master.connect(context.destination);

  // file → decoded sound, so a clip heard again isn't downloaded and decoded again.
  // A decoded 5-second clip takes about 1 MB of memory; keeping all 181 would grow to
  // ~180 MB over a long session, so only the most recently used ones are kept (step 8).
  const buffers = new Map();
  const playing = new Set(); // { source, gain } of every sound still sounding

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
    // Plays one sound for CONFIG.playback.seconds, fading in and out, on top of
    // whatever is already playing.
    async play(file) {
      const buffer = await load(file);
      const seconds = CONFIG.playback.seconds;
      const fade = Math.min(CONFIG.playback.fadeSeconds, seconds / 2);

      const source = context.createBufferSource();
      source.buffer = buffer;
      source.loop = true; // a 5-second clip plays twice to fill 10 seconds
      const gain = context.createGain();
      gain.gain.value = 0; // silent until the fade-in begins
      source.connect(gain).connect(master);

      // Schedule the whole envelope in advance; the browser carries it out exactly.
      const start = context.currentTime + 0.05;
      gain.gain.setValueCurveAtTime(FADE_IN, start, fade);
      gain.gain.setValueCurveAtTime(FADE_OUT, start + seconds - fade, fade);
      source.start(start);
      source.stop(start + seconds);

      const sound = { source, gain };
      playing.add(sound);
      source.onended = () => {
        source.disconnect();
        gain.disconnect();
        playing.delete(sound);
      };
    },

    // Fades out everything that is playing (e.g. when a recording ends).
    stop() {
      const now = context.currentTime;
      for (const { source, gain } of playing) {
        // Freeze the envelope where it is… (older browsers: cancel, then pin the current value)
        if (gain.gain.cancelAndHoldAtTime) {
          gain.gain.cancelAndHoldAtTime(now);
        } else {
          const current = gain.gain.value;
          gain.gain.cancelScheduledValues(now);
          gain.gain.setValueAtTime(current, now);
        }
        gain.gain.linearRampToValueAtTime(0, now + STOP_SECONDS); // …and fade from there
        source.stop(now + STOP_SECONDS);
      }
    },
  };
}
