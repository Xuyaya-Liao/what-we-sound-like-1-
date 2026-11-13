// speech-worker.js: the "what we say" models, in their own Web Worker
// (a second one, next to sound-worker.js, so both paths run at the same time).
//
//   Whisper: the last 10 s of 16 kHz speech → text, in the language spoken (never
//            translated), plus which language Whisper heard. "small" on the graphics
//            card when the computer can, "base" on the processor otherwise (config.js).
//   Text model (multilingual MiniLM): a sentence in any language → 384 numbers.
//            Sentences that mean similar things get similar numbers, whatever the
//            language. Comparing the transcript with each label's English description
//            finds the closest label. This is the fallback for the LLM (step 6).
//
// Messages it understands:
//   { type: "load" }                → loads both models (sent right away) → { whisper }
//   { type: "labels", labels, soundCategories } → embeds every label once (sent when the
//            label table is in); if soundCategories is also given, embeds those too and
//            returns { matchMatrix }, comparing every sound category with every label (step 10)
//   { type: "transcribe", samples } → { text, language, seconds, ms }
//   { type: "label", text }         → { ranking: [{ id, score }…] best first, ms }

import { CONFIG } from "../config.js";

let loading; // the models, once loaded (a promise, so early calls share one download)
let labels; // [{ id, vector }] for every label

function load() {
  loading ??= (async () => {
    const tf = await import(CONFIG.transformersUrl);
    tf.env.allowLocalModels = false; // always fetch models from Hugging Face, not from our server

    // Tells the page how far each download has got (in bytes, for the loading bar)
    const progress = (model, dtype) => (event) => {
      if (event.status === "progress_total" && event.files) {
        const { loaded, total } = countBytes(event.files, dtype);
        if (total) self.postMessage({ type: "progress", model, progress: (100 * loaded) / total, loaded, total });
      }
    };

    // Whisper on the graphics card if this computer can, otherwise on the processor
    async function loadBestWhisper() {
      const choice = (await canUseGpu()) ? CONFIG.speech.gpu : CONFIG.speech.cpu;
      try {
        return { ...(await loadWhisper(tf, choice, progress)), name: choice.name };
      } catch (error) {
        if (choice === CONFIG.speech.cpu) throw error;
        console.warn("Whisper could not run on the GPU, using the CPU instead:", error);
        return { ...(await loadWhisper(tf, CONFIG.speech.cpu, progress)), name: CONFIG.speech.cpu.name };
      }
    }

    // Both models download at the same time
    const [whisperParts, embed] = await Promise.all([
      loadBestWhisper(),
      tf.pipeline("feature-extraction", CONFIG.models.fallbackText, {
        device: "wasm",
        dtype: "q8",
        progress_callback: progress("Text model"),
      }),
    ]);
    return { tf, ...whisperParts, embed, start: whisperStart(tf, whisperParts.whisper.generation_config) };
  })();
  loading.catch(() => {
    loading = undefined; // if loading fails (e.g. no internet), the next call tries again
  });
  return loading;
}

// Adds up the bytes of every file being downloaded: { "onnx/x.onnx": { loaded, total }… }.
// transformers.js 4.3.2 has a bug when the parts of a model use different dtypes (our
// GPU Whisper: { encoder_model: "fp16", decoder_model_merged: "q4" }): it announces
// "onnx/encoder_model.onnx" (the full-size file, 353 MB) but downloads
// "onnx/encoder_model_fp16.onnx" (177 MB) instead, and only lists that one once it
// starts. Counting the announced file would make the bar stall; ignoring it would make
// the bar race ahead and then wait. So until the real file shows up, its size is
// estimated from the announced one: 16-bit is half of full size, 8-bit a quarter…
const SIZE_FACTOR = { fp16: 0.5, q8: 0.25, int8: 0.25, uint8: 0.25, q4: 0.16, q4f16: 0.16, bnb4: 0.16 };

function countBytes(files, dtype) {
  const names = Object.keys(files);
  let loaded = 0;
  let total = 0;
  for (const [name, file] of Object.entries(files)) {
    const part = name.match(/^onnx\/(.+)\.onnx$/)?.[1]; // e.g. "encoder_model"
    const wanted = typeof dtype === "object" ? dtype[part] : undefined; // e.g. "fp16"
    if (wanted && wanted !== "fp32") {
      // The announced full-size file: never downloaded, only used for the estimate
      const realFileListed = names.some((other) => other.startsWith(`onnx/${part}_`));
      if (!realFileListed) total += file.total * (SIZE_FACTOR[wanted] ?? 1);
      continue;
    }
    loaded += file.loaded;
    total += file.total;
  }
  return { loaded, total };
}

// WebGPU is how a web page uses the graphics card. navigator.gpu only exists in
// browsers that support it; the "adapter" is the graphics card itself. Our GPU
// version of Whisper uses 16-bit numbers, which not every card can do ("shader-f16").
async function canUseGpu() {
  try {
    const adapter = await navigator.gpu?.requestAdapter();
    return Boolean(adapter?.features.has("shader-f16"));
  } catch {
    return false;
  }
}

// Whisper in three parts: the processor turns sound into a spectrogram (a picture
// of frequencies over time), the model turns that into word pieces (tokens),
// and the tokenizer turns tokens back into text.
async function loadWhisper(tf, choice, progress) {
  const [processor, tokenizer, whisper] = await Promise.all([
    tf.AutoProcessor.from_pretrained(choice.model),
    tf.AutoTokenizer.from_pretrained(choice.model),
    tf.WhisperForConditionalGeneration.from_pretrained(choice.model, {
      device: choice.device,
      dtype: choice.dtype,
      progress_callback: progress("Whisper", choice.dtype),
    }),
  ]);
  return { processor, tokenizer, whisper };
}

// ---- Letting Whisper detect the language ----
// Whisper writes its answer as a sequence of tokens (word pieces). It always begins:
//     <|startoftranscript|> <|zh|> <|transcribe|> <|notimestamps|> 湖面很安静…
// The second token is the language. transformers.js 4.3.2 can't detect it: without a
// language it simply puts <|en|> there (see its modeling_whisper.js, "TODO: Implement
// language detection"), and Whisper then translates everything into English.
//
// So we start from <|startoftranscript|> alone and steer only the next three choices
// with a "logits processor" (it sees the score of every possible next token, and may
// change them before Whisper picks one):
//   1st choice: only language tokens allowed → Whisper picks the language it hears
//   2nd choice: forced to <|transcribe|>      → never translate
//   3rd choice: forced to <|notimestamps|>
//   after that: untouched                     → Whisper writes the text
function whisperStart(tf, config) {
  const languageIds = Object.values(config.lang_to_id);
  const idToLanguage = new Map(Object.entries(config.lang_to_id).map(([token, id]) => [id, token.slice(2, -2)]));

  class LetWhisperChooseLanguage extends tf.LogitsProcessor {
    _call(inputIds, logits) {
      for (let i = 0; i < inputIds.length; i++) {
        const scores = logits[i].data;
        const step = inputIds[i].length; // tokens so far, including <|startoftranscript|>
        if (step === 1) {
          const kept = languageIds.map((id) => scores[id]);
          scores.fill(-Infinity);
          languageIds.forEach((id, k) => (scores[id] = kept[k]));
        } else if (step === 2) {
          scores.fill(-Infinity);
          scores[config.task_to_id.transcribe] = 0;
        } else if (step === 3) {
          scores.fill(-Infinity);
          scores[config.no_timestamps_token_id] = 0;
        }
      }
      return logits;
    }
  }

  return {
    startToken: config.decoder_start_token_id,
    processors() {
      const list = new tf.LogitsProcessorList();
      list.push(new LetWhisperChooseLanguage());
      return list;
    },
    languageOf: (tokens) => idToLanguage.get(tokens[1]) ?? "?",
  };
}

// One sentence (or several) → unit vectors, as plain lists of numbers
async function embedTexts(embed, texts) {
  const output = await embed(texts, { pooling: "mean", normalize: true });
  return output.tolist();
}

function similarity(a, b) {
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += a[i] * b[i];
  return sum;
}

// Compares every sound category with every image label (by their English
// descriptions, embedded with the same multilingual model) and turns the raw
// similarities into a 0–1 "how well do these go together" score (step 10's
// "mismatch" is 1 minus this).
//
// This is a PERCENTILE RANK, not a min–max scale: each pair's score is where it
// falls among all the others (0 = the worst pair in the whole table, 1 = the
// best, 0.5 = exactly in the middle), not how close its raw similarity is to the
// best/worst value. Checked on 2026-11-13: the 432 raw similarities cluster
// fairly narrowly (median similarity only a little above the lowest one), so a
// min–max scale left almost every real pairing reading as "fairly mismatched" —
// the visuals looked busy and unclear almost all the time, whatever was actually
// chosen. Ranking guarantees an even spread instead: about half of all pairings
// land below 0.5 and half above, whatever the raw numbers look like, so a
// "typically good" pairing reads as calm and a visitor can tell the two from the
// occasional truly bad one.
function buildMatchMatrix(categories, categoryVectors, labelIds, labelVectors) {
  const raw = categoryVectors.map((categoryVector) => labelVectors.map((labelVector) => similarity(categoryVector, labelVector)));
  const sorted = [...raw.flat()].sort((a, b) => a - b);
  const rank = (value) => {
    // How many sorted values are below this one (binary search), as a 0–1 fraction
    let lo = 0;
    let hi = sorted.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (sorted[mid] < value) lo = mid + 1;
      else hi = mid;
    }
    return lo / (sorted.length - 1);
  };
  return {
    categories: categories.map((category) => category.id),
    labels: labelIds,
    values: raw.map((row) => row.map(rank)),
  };
}

self.onmessage = async ({ data }) => {
  try {
    const models = await load();
    let result = {};

    if (data.type === "load") {
      result = { whisper: models.name }; // e.g. "small · GPU", for the debug panel
    }

    if (data.type === "labels") {
      // What each label "means": its name and description, in English.
      // The transcript can be in any language; the model lines meanings up across languages.
      const texts = data.labels.map((label) => `${label.name}: ${label.description}`);
      const vectors = await embedTexts(models.embed, texts);
      labels = data.labels.map((label, i) => ({ id: label.id, vector: vectors[i] }));

      // Step 10: also compare every sound category with every label, for the visuals' mismatch.
      if (data.soundCategories?.length) {
        const categoryVectors = await embedTexts(models.embed, data.soundCategories.map((c) => c.description));
        result.matchMatrix = buildMatchMatrix(data.soundCategories, categoryVectors, labels.map((l) => l.id), vectors);
      }
    }

    if (data.type === "transcribe") {
      const started = performance.now();
      const inputs = await models.processor(data.samples);
      const output = await models.whisper.generate({
        ...inputs,
        decoder_input_ids: [models.start.startToken], // start with <|startoftranscript|> only…
        logits_processor: models.start.processors(), // …and let Whisper choose the language (see above)
        max_new_tokens: 96,
      });
      const tokens = output.tolist()[0].map(Number);
      const text = models.tokenizer.decode(tokens, { skip_special_tokens: true }).trim();
      result = {
        text,
        language: models.start.languageOf(tokens),
        seconds: data.samples.length / CONFIG.speechSampleRate, // how much it heard: 5 or 10 s
        ms: Math.round(performance.now() - started),
      };
    }

    if (data.type === "label") {
      if (!labels) throw new Error("The labels are not loaded yet");
      const started = performance.now();
      const [vector] = await embedTexts(models.embed, [data.text]);
      const ranking = labels
        .map((label) => ({ id: label.id, score: similarity(vector, label.vector) }))
        .sort((a, b) => b.score - a.score);
      result = { ranking, ms: Math.round(performance.now() - started) };
    }

    self.postMessage({ id: data.id, result });
  } catch (error) {
    self.postMessage({ id: data.id, error: error.message });
  }
};
