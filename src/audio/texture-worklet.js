// Short, windowed grains and local saturation, blended with the original sound.
// At mismatch 0 the output is exactly the input. No processing enters the mic path.
class NatureTexture extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [
      { name: "mismatch", defaultValue: 0, minValue: 0, maxValue: 1, automationRate: "k-rate" },
      { name: "wet", defaultValue: 0.35, minValue: 0, maxValue: 1, automationRate: "k-rate" },
    ];
  }

  constructor() {
    super();
    this.rings = [new Float32Array(Math.ceil(sampleRate * 0.3)), new Float32Array(Math.ceil(sampleRate * 0.3))];
    this.write = 0;
    this.samplesSeen = 0;
    this.cycle = 0;
    this.phase = 0;
    this.grainPhase = 0;
    this.amount = 0;
    this.smoothing = 1 - Math.exp(-1 / (sampleRate * 0.12));
  }

  process(inputs, outputs, parameters) {
    const input = inputs[0];
    const output = outputs[0];
    const target = parameters.mismatch[0];
    for (let i = 0; i < output[0].length; i++) {
      this.amount += (target - this.amount) * this.smoothing;
      const strength = this.amount * this.amount;
      // A few short fragments per second; more frequent as mismatch rises.
      this.phase += (2 + strength * 7) / sampleRate;
      if (this.phase >= 1) { this.phase -= 1; this.cycle++; }
      const duration = 0.25 + strength * 0.4;
      const local = Math.min(1, this.phase / duration);
      const window = Math.sin(Math.PI * local) ** 2;
      const grainSamples = Math.round(sampleRate * (0.022 + 0.025 * (0.5 + 0.5 * Math.sin(this.cycle * 2.39))));
      this.grainPhase = (this.grainPhase + 1 / grainSamples) % 1;
      const a = this.grainPhase;
      const b = (a + 0.5) % 1;
      const weight = Math.sin(Math.PI * a) ** 2;
      const drive = 1 + strength * 12;
      const mix = this.samplesSeen > sampleRate * 0.1 ? strength * window * parameters.wet[0] : 0;
      const length = this.rings[0].length;
      for (let channel = 0; channel < output.length; channel++) {
        const dry = input?.[channel]?.[i] ?? input?.[0]?.[i] ?? 0;
        const ring = this.rings[channel];
        ring[this.write] = dry;
        const readA = (this.write - grainSamples * 2 + Math.floor(a * grainSamples * 0.7) + length) % length;
        const readB = (this.write - grainSamples * 2 + Math.floor(b * grainSamples * 0.7) + length) % length;
        // Two Hann windows overlap: each grain resets while its own weight is zero.
        const grain = ring[readA] * weight + ring[readB] * (1 - weight);
        const saturated = Math.tanh(grain * drive) / drive;
        output[channel][i] = dry * (1 - mix) + saturated * mix;
      }
      this.write = (this.write + 1) % length;
      this.samplesSeen++;
    }
    return true;
  }
}

registerProcessor("nature-texture", NatureTexture);
