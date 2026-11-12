// clap.mjs: loads CLAP in Node and turns 5 seconds of sound into a vector.
//
// This is the same code as the professor's CLAP example, running in Node
// instead of the browser:
//     processor = await AutoProcessor.from_pretrained("Xenova/clap-htsat-unfused")
//     audioModel = await ClapAudioModelWithProjection.from_pretrained(...)
//     results = await audioModel(await processor(section))
//
// One important detail: the browser (step 4) must use exactly the same model
// AND the same "dtype" (q8 = the compressed 8-bit version), otherwise the vectors
// computed here and the ones computed live would not be comparable.

import {
  AutoProcessor,
  AutoTokenizer,
  ClapAudioModelWithProjection,
  ClapTextModelWithProjection,
} from "@huggingface/transformers";

export const CLAP_MODEL = "Xenova/clap-htsat-unfused";
export const CLAP_DTYPE = "q8";
export const CLAP_RATE = 48000; // CLAP expects 48000 samples per second
export const CLAP_SECONDS = 5;

let loading;

// Loads the model once; later calls reuse it.
// The first run downloads it from Hugging Face (and caches it on disk).
export function loadClap() {
  loading ??= (async () => {
    const processor = await AutoProcessor.from_pretrained(CLAP_MODEL);
    const model = await ClapAudioModelWithProjection.from_pretrained(CLAP_MODEL, { dtype: CLAP_DTYPE });
    return { processor, model };
  })();
  return loading;
}

// samples: a Float32Array at 48 kHz, at most 5 seconds.
// Returns a list of 512 numbers with length 1 (a "unit vector"),
// so comparing two vectors is just multiplying and adding (cosine similarity).
export async function embedSound(samples) {
  const { processor, model } = await loadClap();
  const results = await model(await processor(samples));
  return unitVector(results.audio_embeds.data);
}

// CLAP was trained on sounds AND their descriptions, so it can also turn text into
// a vector in the same space. similarity(soundVector, textVector) then says how well
// the text describes the sound. Returns one vector per text.
let textLoading;
export async function embedTexts(texts) {
  textLoading ??= Promise.all([
    AutoTokenizer.from_pretrained(CLAP_MODEL),
    ClapTextModelWithProjection.from_pretrained(CLAP_MODEL, { dtype: CLAP_DTYPE }),
  ]);
  const [tokenizer, model] = await textLoading;
  const output = (await model(tokenizer(texts, { padding: true, truncation: true }))).text_embeds.data;
  return texts.map((_, i) => unitVector(output.subarray(i * 512, (i + 1) * 512)));
}

// The average of many vectors (used for centering, see build-vectors.mjs)
export function meanVector(vectors) {
  const mean = new Array(vectors[0].length).fill(0);
  for (const vector of vectors) {
    for (let i = 0; i < mean.length; i++) mean[i] += vector[i] / vectors.length;
  }
  return mean;
}

// "Centering": subtract the average, then scale back to length 1
export function centered(vector, mean) {
  return unitVector(vector.map((value, i) => value - mean[i]));
}

export function unitVector(values) {
  const length = Math.hypot(...values);
  return Array.from(values, (value) => value / length);
}

// Cosine similarity of two unit vectors: 1 = same direction (very similar), 0 = unrelated.
export function similarity(a, b) {
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += a[i] * b[i];
  return sum;
}
