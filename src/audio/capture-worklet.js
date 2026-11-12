// capture-worklet.js: collects the raw sound samples coming in, and hands them
// to the main program in small batches.
//
// What is an AudioWorklet?
// The browser processes sound on its own separate "audio thread", so audio never
// stutters even when the page is busy. Code that wants to touch the samples
// directly must run on that thread. This file is loaded there (by capture.js,
// via audioWorklet.addModule), not as a normal script.
//
// The audio thread calls process() over and over, each time with 128 new samples
// (about 3 ms of sound). We copy them into a buffer, and every 2048 samples
// (about 40 ms) post the batch to the main thread with port.postMessage().
// Sending every 128 samples would also work, just with many more messages.

const BATCH = 2048;

class CaptureCollector extends AudioWorkletProcessor {
  constructor() {
    super();
    this.batch = new Float32Array(BATCH);
    this.filled = 0;
  }

  process(inputs) {
    // inputs[0] = the first input, [0] = its first channel.
    // capture.js asks for mono, so the browser has already mixed the channels into one.
    const samples = inputs[0][0];
    if (samples) {
      for (let i = 0; i < samples.length; i++) {
        this.batch[this.filled++] = samples[i];
        if (this.filled === BATCH) {
          this.port.postMessage(this.batch);
          this.batch = new Float32Array(BATCH); // start a fresh one; the old one now belongs to the main thread
          this.filled = 0;
        }
      }
    }
    return true; // keep running
  }
}

registerProcessor("capture-collector", CaptureCollector);
