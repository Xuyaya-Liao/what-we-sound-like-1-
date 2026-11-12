// loudness.mjs: measures how loud a sound *feels*, and evens out loudness across clips.
//
// Why not just use the biggest sample value (the peak)? Because a single crack of
// thunder can hit the peak while the rest of the clip is quiet, and steady rain can
// feel loud without any big peaks. Ears respond to average energy, and more to
// some frequencies than others.
//
// The standard answer is ITU-R BS.1770, measured in LUFS (loudness units relative
// to full scale). Broadcasters and streaming services use it. In short:
//   1. "K-weighting": filter the sound so it roughly matches how ears hear
//      (cut very low rumble, boost the high-mids a little)
//   2. Cut it into 400 ms blocks and measure each block's average energy
//   3. Ignore near-silent blocks, so pauses don't drag the number down
//   4. Average the rest and convert to LUFS. -23 LUFS is the broadcast norm;
//      a louder clip has a higher (less negative) number.

// ---- Step 1: K-weighting filters ----
// Two "biquad" filters in a row. The formulas give the standard coefficients
// for any sample rate (they match the published 48 kHz table exactly).
function kWeightingFilters(sampleRate) {
  // Filter A: high shelf, +4 dB above about 1.7 kHz (the head's acoustic effect)
  let K = Math.tan((Math.PI * 1681.974450955533) / sampleRate);
  const gain = 10 ** (3.99984385397 / 20);
  const shelf = gain ** 0.499666774155;
  const Q1 = 0.7071752369554193;
  let a0 = 1 + K / Q1 + K * K;
  const shelfFilter = {
    b: [(gain + (shelf * K) / Q1 + K * K) / a0, (2 * (K * K - gain)) / a0, (gain - (shelf * K) / Q1 + K * K) / a0],
    a: [(2 * (K * K - 1)) / a0, (1 - K / Q1 + K * K) / a0],
  };

  // Filter B: high pass, removes rumble below about 38 Hz
  K = Math.tan((Math.PI * 38.13547087613982) / sampleRate);
  const Q2 = 0.5003270373253953;
  a0 = 1 + K / Q2 + K * K;
  const highPass = {
    b: [1, -2, 1],
    a: [(2 * (K * K - 1)) / a0, (1 - K / Q2 + K * K) / a0],
  };

  return [shelfFilter, highPass];
}

function applyFilter(samples, { b, a }) {
  const output = new Float32Array(samples.length);
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
  for (let i = 0; i < samples.length; i++) {
    const x = samples[i];
    const y = b[0] * x + b[1] * x1 + b[2] * x2 - a[0] * y1 - a[1] * y2;
    output[i] = y;
    x2 = x1; x1 = x;
    y2 = y1; y1 = y;
  }
  return output;
}

// Returns the loudness of a mono clip in LUFS (-Infinity for silence).
export function measureLoudness(samples, sampleRate) {
  let weighted = samples;
  for (const filter of kWeightingFilters(sampleRate)) weighted = applyFilter(weighted, filter);

  // ---- Step 2: energy of each 400 ms block, a new block every 100 ms ----
  const blockSize = Math.round(0.4 * sampleRate);
  const step = Math.round(0.1 * sampleRate);
  const energies = [];
  for (let start = 0; start + blockSize <= weighted.length; start += step) {
    let sum = 0;
    for (let i = start; i < start + blockSize; i++) sum += weighted[i] * weighted[i];
    energies.push(sum / blockSize);
  }
  if (!energies.length) {
    // Shorter than 400 ms: measure the whole clip as one block
    energies.push(weighted.reduce((sum, value) => sum + value * value, 0) / weighted.length);
  }

  // ---- Steps 3 and 4: ignore quiet blocks, average the rest ----
  const toLufs = (energy) => -0.691 + 10 * Math.log10(energy);
  const average = (list) => list.reduce((sum, value) => sum + value, 0) / list.length;

  const audible = energies.filter((energy) => toLufs(energy) > -70); // absolute gate: near silence
  if (!audible.length) return -Infinity;
  const relativeGate = toLufs(average(audible)) - 10; // relative gate: 10 LU below the average
  const counted = audible.filter((energy) => toLufs(energy) > relativeGate);
  return toLufs(average(counted));
}

// Turns a clip up or down so it reaches the target loudness, without letting any
// sample go above the ceiling (that would clip and crackle).
// Returns the new samples plus a short note on what happened.
export function normalizeLoudness(samples, sampleRate, { targetLufs, peakCeilingDb, maxBoostDb }) {
  const loudness = measureLoudness(samples, sampleRate);
  const peak = samples.reduce((max, value) => Math.max(max, Math.abs(value)), 0);
  if (!Number.isFinite(loudness) || peak === 0) {
    return { samples, loudness, gainDb: 0, note: "silent" };
  }

  let gainDb = targetLufs - loudness;
  let note = "ok";
  if (gainDb > maxBoostDb) {
    gainDb = maxBoostDb; // very quiet clip: don't amplify its background hiss too much
    note = "boost-capped";
  }
  const peakAfterDb = 20 * Math.log10(peak) + gainDb;
  if (peakAfterDb > peakCeilingDb) {
    gainDb -= peakAfterDb - peakCeilingDb; // sharp peaks: stop at the ceiling, stay a bit quieter
    note = "peak-limited";
  }

  const factor = 10 ** (gainDb / 20);
  return { samples: samples.map((value) => value * factor), loudness, gainDb, note };
}
