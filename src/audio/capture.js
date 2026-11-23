// capture.js: turns a live sound source into a stream of 5-second segments.
//
// The source is either the microphone, or a recording (played back in real time,
// as if someone were speaking it into the microphone). Both go through exactly
// the same path, so a recording is a repeatable stand-in for a visitor.
//
//   source ──▶ collector (capture-worklet.js) ──batches──▶ here ──every 5 s──▶ onSegment()
//                                                          └─────────────────▶ onLevel()  (live loudness, ~25×/s)
//
// Segments are cut by counting samples, not with a timer: every segment holds
// exactly 5 seconds of sound, even if the page was briefly busy.

import { CONFIG } from "../config.js";

// Loudness in decibels relative to full scale (dBFS): 0 is the loudest possible,
// -20 is normal speech close to a laptop mic, -60 and below is a quiet room.
export function levelDb(samples) {
  let sum = 0;
  for (let i = 0; i < samples.length; i++) sum += samples[i] * samples[i];
  const rms = Math.sqrt(sum / samples.length);
  return rms > 0 ? 20 * Math.log10(rms) : -Infinity;
}

// Below this, a microphone is sending (almost) pure zeros: not a quiet room,
// which is around -60 dB, but no signal at all. Usually the wrong device,
// a system mute, or a missing permission in the operating system.
export const NO_SIGNAL_DB = -100;

// Lists the microphones the browser can see (names only appear after permission is given).
export async function listMicrophones() {
  const devices = await navigator.mediaDevices.enumerateDevices();
  return devices.filter((device) => device.kind === "audioinput");
}

// The worklet file only needs to be loaded once per AudioContext
const contextsWithWorklet = new WeakSet();

// Starts listening. Options:
//   context: the AudioContext (the browser's sound engine) shared by the whole piece
//   recording: a File or a URL string to play instead of the microphone (optional)
//   deviceId: which microphone to use (optional; the browser's default otherwise)
//   loop: play the recording over and over (for long tests; optional)
//   onSegment(segment): called every roundSeconds with { index, startSec, samples, sampleRate, levelDb, quiet }
//   onLevel(db): called many times a second with the current loudness, for meters and visuals
//   onEnd(): called when a recording has finished playing
// Returns an object with stop(), plus details for the debug panel.
//   onPeek(peek): called once partway through each segment (CONFIG.speech.peekSeconds)
//     with { samples, sampleRate, levelDb }: the part of the segment collected so far
export async function startCapture({ context, recording, deviceId, loop = false, onSegment, onPeek, onLevel, onSamples, onEnd }) {
  // The AudioContext runs at its own sample rate (usually 48000, sometimes 44100).
  // Resampling to what each model needs happens later, in resample.js.
  if (!contextsWithWorklet.has(context)) {
    await context.audioWorklet.addModule(new URL("./capture-worklet.js", import.meta.url));
    contextsWithWorklet.add(context);
  }

  const collector = new AudioWorkletNode(context, "capture-collector", {
    channelCount: 1, // mix everything down to mono…
    channelCountMode: "explicit", // …no matter how many channels the source has
  });

  // A node only runs if its output leads to the speakers. Route the collector
  // through a volume of 0, so it runs but you don't hear it twice.
  const mute = context.createGain();
  mute.gain.value = 0;
  collector.connect(mute).connect(context.destination);

  // ---- Connect the source ----
  let stream;
  let player;
  let label;
  let microphone; // details about the microphone in use, for the debug panel
  if (recording) {
    // A recording: decode it, play it into the collector AND to the speakers,
    // so you can hear what is being analysed.
    const bytes = typeof recording === "string"
      ? await (await fetch(recording)).arrayBuffer()
      : await recording.arrayBuffer();
    player = context.createBufferSource();
    player.buffer = await context.decodeAudioData(bytes);
    player.loop = loop; // when looping, it never ends (onended below is never called)
    player.connect(collector);
    player.connect(context.destination);
    player.onended = () => {
      flush(); // hand over the last, shorter piece too
      onEnd?.();
    };
    player.start();
    label = `Recording: ${typeof recording === "string" ? recording : recording.name}${loop ? " (looping)" : ""}`;
  } else {
    // The microphone: the browser asks the visitor for permission here.
    // "exact" means: this device or nothing (rather than silently falling back to another one).
    const audio = deviceId ? { ...CONFIG.microphone, deviceId: { exact: deviceId } } : CONFIG.microphone;
    stream = await navigator.mediaDevices.getUserMedia({ audio });
    context.createMediaStreamSource(stream).connect(collector);

    // The "track" is the microphone's audio inside the stream. It knows the device name,
    // and whether the system has muted it (e.g. a mute key, or another app holding the mic).
    const track = stream.getAudioTracks()[0];
    microphone = { track, deviceId: track.getSettings().deviceId };
    label = `Microphone: ${track.label || "unknown device"}${track.muted ? " (muted by the system)" : ""}`;
  }

  // ---- Collect batches into 5-second segments ----
  const segmentLength = Math.round(CONFIG.roundSeconds * context.sampleRate);
  let pending = []; // batches waiting to become a segment
  let pendingLength = 0;
  let index = 0;
  let consumed = 0; // samples already handed over in earlier segments

  // Halfway through a segment, onPeek gets what has been collected so far (see
  // CONFIG.speech.peekSeconds), so the words can reach the screen before the round ends
  const peekLength = Math.round((CONFIG.speech.peekSeconds || 0) * context.sampleRate);
  let peeked = false;

  collector.port.onmessage = ({ data: batch }) => {
    onLevel?.(levelDb(batch));
    onSamples?.(batch, context.sampleRate);
    pending.push(batch);
    pendingLength += batch.length;
    while (pendingLength >= segmentLength) emit(segmentLength);
    if (onPeek && peekLength && !peeked && pendingLength >= peekLength && peekLength < segmentLength) {
      peeked = true;
      const samples = joinPending();
      onPeek({ samples, sampleRate: context.sampleRate, levelDb: levelDb(samples) });
    }
  };

  function joinPending() {
    const joined = new Float32Array(pendingLength);
    let at = 0;
    for (const batch of pending) {
      joined.set(batch, at);
      at += batch.length;
    }
    return joined;
  }

  // Glue the waiting batches together, cut off one segment, keep the leftover.
  function emit(length) {
    const joined = joinPending();
    const samples = joined.slice(0, length);
    pending = [joined.slice(length)];
    pendingLength = joined.length - length;
    peeked = false; // the next segment gets its own peek

    const db = levelDb(samples);
    onSegment({
      index: index++,
      startSec: consumed / context.sampleRate,
      samples,
      sampleRate: context.sampleRate,
      levelDb: db,
      quiet: db < CONFIG.quietBelowDb,
    });
    consumed += length;
  }

  // At the end of a recording, pass on what's left if it's at least 1 second long.
  function flush() {
    if (pendingLength >= context.sampleRate) emit(pendingLength);
  }

  return {
    context,
    label,
    microphone,
    sampleRate: context.sampleRate,
    // Stops this input. The shared AudioContext keeps running (the nature sound goes on).
    stop() {
      if (player) player.onended = null;
      player?.stop();
      stream?.getTracks().forEach((track) => track.stop()); // turns the mic light off
      collector.port.onmessage = null;
      collector.disconnect();
    },
  };
}
