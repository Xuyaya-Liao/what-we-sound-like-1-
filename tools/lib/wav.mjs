// wav.mjs: read and write WAV files in Node.
//
// In the browser, decodeAudioData does this for us. Node has no audio decoder,
// but WAV is simple enough to read by hand: a short header that describes the
// format, followed by the raw sample numbers.
//
// A WAV file is a list of "chunks". Each chunk starts with a 4-letter name and
// its size. We need two of them: "fmt " (the format) and "data" (the samples).
// Some recorders add extra chunks (notes, markers…), so we walk the list
// instead of assuming fixed positions.

import fs from "node:fs";

// Returns { sampleRate, channels }, where channels is a list of Float32Arrays
// (one per channel) with values between -1 and 1, like getChannelData() in the browser.
export function readWav(file) {
  const bytes = fs.readFileSync(file);
  if (bytes.toString("ascii", 0, 4) !== "RIFF" || bytes.toString("ascii", 8, 12) !== "WAVE") {
    throw new Error(`${file} is not a WAV file`);
  }

  let format;
  let data;
  for (let offset = 12; offset + 8 <= bytes.length; ) {
    const name = bytes.toString("ascii", offset, offset + 4);
    const size = bytes.readUInt32LE(offset + 4);
    const body = offset + 8;
    if (name === "fmt ") {
      format = {
        code: bytes.readUInt16LE(body), // 1 = whole numbers (PCM), 3 = decimals (float), 0xFFFE = "see extension"
        channels: bytes.readUInt16LE(body + 2),
        sampleRate: bytes.readUInt32LE(body + 4),
        bits: bytes.readUInt16LE(body + 14),
      };
      if (format.code === 0xfffe) format.code = bytes.readUInt16LE(body + 24);
    } else if (name === "data") {
      data = bytes.subarray(body, Math.min(body + size, bytes.length));
    }
    offset = body + size + (size % 2); // chunks are padded to an even length
  }
  if (!format || !data) throw new Error(`${file}: missing fmt or data chunk`);

  // Pick how to turn the stored bytes back into numbers between -1 and 1.
  const width = format.bits / 8;
  const readers = {
    "1/16": (at) => data.readInt16LE(at) / 32768,
    "1/24": (at) => data.readIntLE(at, 3) / 8388608,
    "1/32": (at) => data.readInt32LE(at) / 2147483648,
    "3/32": (at) => data.readFloatLE(at),
  };
  const read = readers[`${format.code}/${format.bits}`];
  if (!read) throw new Error(`${file}: unsupported WAV format (code ${format.code}, ${format.bits} bit)`);

  // Samples are interleaved: left, right, left, right… Split them per channel.
  const frames = Math.floor(data.length / (width * format.channels));
  const channels = Array.from({ length: format.channels }, () => new Float32Array(frames));
  for (let frame = 0; frame < frames; frame++) {
    for (let channel = 0; channel < format.channels; channel++) {
      channels[channel][frame] = read((frame * format.channels + channel) * width);
    }
  }
  return { sampleRate: format.sampleRate, channels };
}

// Writes one channel of samples (-1…1) as a 16-bit mono WAV file.
export function writeWav(file, samples, sampleRate) {
  const bytes = Buffer.alloc(44 + samples.length * 2);
  bytes.write("RIFF", 0, "ascii");
  bytes.writeUInt32LE(bytes.length - 8, 4);
  bytes.write("WAVE", 8, "ascii");
  bytes.write("fmt ", 12, "ascii");
  bytes.writeUInt32LE(16, 16); // size of the fmt chunk
  bytes.writeUInt16LE(1, 20); // PCM
  bytes.writeUInt16LE(1, 22); // mono
  bytes.writeUInt32LE(sampleRate, 24);
  bytes.writeUInt32LE(sampleRate * 2, 28); // bytes per second
  bytes.writeUInt16LE(2, 32); // bytes per frame
  bytes.writeUInt16LE(16, 34); // bits per sample
  bytes.write("data", 36, "ascii");
  bytes.writeUInt32LE(samples.length * 2, 40);
  for (let i = 0; i < samples.length; i++) {
    const value = Math.max(-1, Math.min(1, samples[i]));
    bytes.writeInt16LE(Math.round(value < 0 ? value * 32768 : value * 32767), 44 + i * 2);
  }
  fs.writeFileSync(file, bytes);
}

// Mixes all channels into one (the average), for stereo recordings.
export function toMono(channels) {
  if (channels.length === 1) return channels[0];
  const mono = new Float32Array(channels[0].length);
  for (const channel of channels) {
    for (let i = 0; i < mono.length; i++) mono[i] += channel[i] / channels.length;
  }
  return mono;
}

// Changes the sample rate with straight-line interpolation between samples.
// When going down (e.g. 48 kHz → 16 kHz), frequencies the new rate can't hold
// (above 8 kHz here) are filtered out first. Otherwise they "fold" back down as
// false low sounds (aliasing): crickets at 12 kHz would appear at 4 kHz.
// When going up (e.g. 24 kHz → 48 kHz), the straight lines leave faint false copies
// of the sound above the original top frequency, so those are filtered out after.
export function resample(samples, fromRate, toRate) {
  if (fromRate === toRate) return samples;
  if (toRate < fromRate) samples = lowPass(samples, (0.45 * toRate) / fromRate);
  const output = new Float32Array(Math.floor((samples.length * toRate) / fromRate));
  for (let i = 0; i < output.length; i++) {
    const position = (i * fromRate) / toRate;
    const left = Math.floor(position);
    const right = Math.min(left + 1, samples.length - 1);
    output[i] = samples[left] + (samples[right] - samples[left]) * (position - left);
  }
  return toRate > fromRate ? lowPass(output, (0.45 * fromRate) / toRate) : output;
}

// Keeps frequencies below `cutoff` (a fraction of the sample rate, e.g. 0.15) and
// removes those above, using a standard "windowed sinc" filter with 63 taps.
function lowPass(samples, cutoff) {
  const half = 31;
  const taps = [];
  for (let i = -half; i <= half; i++) {
    const sinc = i === 0 ? 2 * cutoff : Math.sin(2 * Math.PI * cutoff * i) / (Math.PI * i);
    const window = 0.54 + 0.46 * Math.cos((Math.PI * i) / half); // Hamming window
    taps.push(sinc * window);
  }
  const output = new Float32Array(samples.length);
  for (let n = 0; n < samples.length; n++) {
    let sum = 0;
    for (let k = -half; k <= half; k++) {
      const index = n + k;
      if (index >= 0 && index < samples.length) sum += samples[index] * taps[k + half];
    }
    output[n] = sum;
  }
  return output;
}
