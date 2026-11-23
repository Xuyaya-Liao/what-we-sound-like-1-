// Windowed FFT of the latest input: output bands run from low to high frequency.
export function createInputSpectrum(settings) {
  const size = settings.fftSize;
  const ring = new Float32Array(size);
  const real = new Float32Array(size);
  const imag = new Float32Array(size);
  const window = Float32Array.from({ length: size }, (_, i) => 0.5 - 0.5 * Math.cos(2 * Math.PI * i / size));
  const levels = new Float32Array(settings.bands);
  let cursor = 0;
  let rate = 0;
  const reset = () => { ring.fill(0); levels.fill(0); cursor = 0; rate = 0; };

  return {
    levels,
    reset,
    push(samples, sampleRate) {
      if (rate && rate !== sampleRate) reset();
      rate = sampleRate;
      for (const sample of samples) {
        ring[cursor] = sample;
        cursor = (cursor + 1) % size;
      }
      for (let i = 0; i < size; i++) real[i] = ring[(cursor + i) % size] * window[i];
      imag.fill(0);
      fft(real, imag);
      const binHz = rate / size;
      const low = Math.max(binHz, settings.minHz);
      const high = Math.min(rate / 2, settings.maxHz);
      const ratio = high / low;
      const magnitude = (bin) => Math.hypot(real[bin], imag[bin]) * 4 / size;
      for (let i = 0; i < levels.length; i++) {
        // Log spacing gives bass, mids and treble useful space on screen.
        const left = low * ratio ** (i / levels.length) / binHz;
        const right = low * ratio ** ((i + 1) / levels.length) / binHz;
        const center = Math.sqrt(left * right);
        const index = Math.floor(center);
        const fraction = center - index;
        let peak = magnitude(index) * (1 - fraction) + magnitude(Math.min(size / 2, index + 1)) * fraction;
        for (let bin = Math.ceil(left); bin <= Math.floor(right); bin++) peak = Math.max(peak, magnitude(bin));
        const db = 20 * Math.log10(Math.max(1e-8, peak));
        levels[i] = Math.max(0, Math.min(1, (db - settings.floorDb) / (settings.ceilingDb - settings.floorDb)));
      }
    },
  };
}

function fft(real, imag) {
  const size = real.length;
  for (let i = 1, j = 0; i < size; i++) {
    let bit = size >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) [real[i], real[j]] = [real[j], real[i]];
  }
  for (let width = 2; width <= size; width *= 2) {
    const angle = -2 * Math.PI / width;
    const stepReal = Math.cos(angle), stepImag = Math.sin(angle);
    for (let start = 0; start < size; start += width) {
      let wr = 1, wi = 0;
      for (let j = 0; j < width / 2; j++) {
        const a = start + j, b = a + width / 2;
        const tr = wr * real[b] - wi * imag[b];
        const ti = wr * imag[b] + wi * real[b];
        real[b] = real[a] - tr; imag[b] = imag[a] - ti;
        real[a] += tr; imag[a] += ti;
        const next = wr * stepReal - wi * stepImag;
        wi = wr * stepImag + wi * stepReal; wr = next;
      }
    }
  }
}
