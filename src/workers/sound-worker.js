// sound-worker.js: runs CLAP in a Web Worker (see worker-client.js for what that means).
//
// The model code is the professor's CLAP example again:
//     processor = await AutoProcessor.from_pretrained("Xenova/clap-htsat-unfused")
//     audioModel = await ClapAudioModelWithProjection.from_pretrained(...)
//     results = await audioModel(await processor(section))
// with the same settings as tools/lib/clap.mjs (wasm, q8), so the vector of the
// visitor's voice can be compared with the precomputed library vectors.
//
// Messages it understands:
//   { type: "load" }             → loads the model (the page sends this right away)
//   { type: "embed", samples }   → { vector, ms }: 5 s of 48 kHz sound → 512 numbers

import { CONFIG } from "../config.js";

let loading; // the model, once loaded (a promise, so two early calls share one download)

function load() {
  loading ??= (async () => {
    const tf = await import(CONFIG.transformersUrl);
    tf.env.allowLocalModels = false; // always fetch models from Hugging Face, not from our server
    const options = {
      device: "wasm",
      dtype: CONFIG.soundDtype,
      progress_callback(event) {
        // Tells the page how far the download has got (in bytes, for the loading bar)
        if (event.status === "progress_total" && Number.isFinite(event.progress)) {
          const { progress, loaded, total } = event;
          self.postMessage({ type: "progress", model: "CLAP", progress, loaded, total });
        }
      },
    };
    const processor = await tf.AutoProcessor.from_pretrained(CONFIG.models.sound);
    const network = await tf.ClapAudioModelWithProjection.from_pretrained(CONFIG.models.sound, options);
    return { processor, network };
  })();
  // If loading fails (e.g. no internet), forget it, so the next call tries again.
  loading.catch(() => {
    loading = undefined;
  });
  return loading;
}

// Scales a vector to length 1, so similarity is just multiply-and-add
function unitVector(values) {
  let sum = 0;
  for (const value of values) sum += value * value;
  const length = Math.sqrt(sum);
  return Float32Array.from(values, (value) => value / length);
}

self.onmessage = async ({ data }) => {
  try {
    const { processor, network } = await load();
    let result = {};
    if (data.type === "embed") {
      const started = performance.now();
      const output = await network(await processor(data.samples));
      result = { vector: unitVector(output.audio_embeds.data), ms: Math.round(performance.now() - started) };
    }
    self.postMessage({ id: data.id, result });
  } catch (error) {
    self.postMessage({ id: data.id, error: error.message });
  }
};
