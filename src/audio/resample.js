// resample.js: converts a segment to the sample rates the two models need.
//
// A sample rate is how many numbers describe one second of sound.
// CLAP was trained on 48000 per second, Whisper on 16000 per second, and the
// browser records at whatever the sound card uses (usually 48000, sometimes 44100).
// Feeding a model the wrong rate is like playing a record at the wrong speed.
//
// The browser can do this conversion for us: an OfflineAudioContext is a sound
// engine that renders as fast as possible into memory instead of to the speakers.
// We play the segment into one set to the target rate, and read back the result.
// (The earlier demo's speechSamples() used the same trick.)

import { CONFIG } from "../config.js";

export async function resample(samples, fromRate, toRate) {
  if (fromRate === toRate) return samples;
  const length = Math.max(1, Math.round((samples.length * toRate) / fromRate));
  const offline = new OfflineAudioContext(1, length, toRate);
  const buffer = offline.createBuffer(1, samples.length, fromRate);
  buffer.copyToChannel(samples, 0);
  const source = offline.createBufferSource();
  source.buffer = buffer;
  source.connect(offline.destination);
  source.start();
  return (await offline.startRendering()).getChannelData(0);
}

// Returns both versions of a segment: { sound: 48 kHz for CLAP, speech: 16 kHz for Whisper }
export async function prepareSegment(segment) {
  const [sound, speech] = await Promise.all([
    resample(segment.samples, segment.sampleRate, CONFIG.soundSampleRate),
    resample(segment.samples, segment.sampleRate, CONFIG.speechSampleRate),
  ]);
  return { sound, speech };
}
