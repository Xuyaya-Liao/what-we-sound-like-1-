// config.js: every adjustable setting lives here.
// To change the rhythm or swap a model later, edit only this file.
// Each entry notes the step where it starts being used.

export const CONFIG = {
  // Process one chunk of sound every N seconds (step 3)
  roundSeconds: 5,

  // Sample rates the two models expect: CLAP wants 48000 Hz, Whisper wants 16000 Hz (step 3)
  soundSampleRate: 48000,
  speechSampleRate: 16000,

  // A segment quieter than this (in dBFS) counts as "quiet": nobody is speaking.
  // Normal speech near a laptop mic is around -35 to -20; a quiet room is below -55.
  // If quiet rounds get marked as "voice", lower this number; if speech gets
  // marked "quiet", raise it. (step 3)
  quietBelowDb: -50,

  // Microphone settings (step 3). Browsers "clean up" voices by default; for this
  // piece we want the raw timbre, so we only keep echo cancellation, which stops
  // the nature sounds coming out of the speakers from being heard as the visitor.
  microphone: {
    echoCancellation: true,
    noiseSuppression: false, // would smooth away breath and texture
    autoGainControl: false, // would even out loud and soft speaking
  },

  // Models (steps 4 and 5). Each name is the model's address on Hugging Face.
  // Visitors may speak any language: speech is transcribed in its original
  // language (never translated), so both text models below are multilingual.
  models: {
    sound: "Xenova/clap-htsat-unfused", // the same CLAP as the professor's example and the demo
    fallbackText: "Xenova/paraphrase-multilingual-MiniLM-L12-v2", // fallback: multilingual text embedding
  },

  // transformers.js version, the same as the demo (step 4)
  transformersUrl: "https://cdn.jsdelivr.net/npm/@huggingface/transformers@4.3.2",

  // Speech recognition (step 5): multilingual Whisper, which detects the language itself.
  speech: {
    // Whisper hears the last 10 s (the previous round + this one), still once every 5 s.
    // A sentence cut in half at a round boundary is then heard whole the next time.
    listenSeconds: 10,
    // Which Whisper to use. The first one this computer can run is used:
    //   gpu: "small" on the graphics card (WebGPU). Much more accurate, ~1–2 s per round.
    //        Needs a browser with WebGPU and a GPU that does 16-bit maths ("shader-f16").
    //   cpu: "base" on the processor. Works everywhere, less accurate, ~2.5–3.5 s.
    // dtype is how strongly each part is compressed: fp16 = 16-bit, q4 / q8 = 4- / 8-bit.
    gpu: {
      model: "onnx-community/whisper-small",
      device: "webgpu",
      dtype: { encoder_model: "fp16", decoder_model_merged: "q4" },
      name: "small · GPU",
    },
    cpu: {
      model: "onnx-community/whisper-base",
      device: "wasm",
      dtype: "q8",
      name: "base · CPU",
    },
  },

  // The LLM that chooses the label from what was said (step 6, see src/semantic/llm-label.js).
  // Every question costs tokens (money on the OpenRouter account), so it is off by default:
  //   "off": only the local text model chooses. No tokens, no key needed.
  //   "on":  the LLM chooses; the local answer shows first and stays if the LLM fails.
  // While developing, leave this "off" and add ?llm=on to the address bar to test the LLM
  // for one visit (?llm=off does the opposite).
  llm: {
    mode: "off",
    // The model's name on OpenRouter. About 700 tokens per question; at $0.10 per million
    // prompt tokens and $0.50 per million answer tokens (2026-11-12), 1000 questions ≈ $0.07.
    model: "anthropic/claude-haiku-5.5",
    url: "https://openrouter.ai/api/v1/chat/completions",
    maxTokens: 10, // the answer is one label id, a few tokens
    // How long the LLM "thinks" before answering. OpenRouter's default for this model is
    // "medium": it thinks first, and the thinking used up the 10 tokens before the
    // answer, so the reply came back empty. Choosing a label doesn't need it: "none".
    reasoning: "none",
    timeoutSeconds: 4, // no answer by then: keep the local label
  },

  // The images (step 7, see src/image/image-choice.js). Each time a label is chosen,
  // the next image from that label's shuffle bag fades in over the last one.
  images: {
    recent: 4, // avoid the last 4 images shown (at most half of a label's images)
    fadeSeconds: 2, // how long one image takes to fade into the next
  },

  // Phrases Whisper tends to "hear" in noise or silence (step 5, see src/semantic/transcript.js).
  // A transcript that is exactly one of these (ignoring case and punctuation) is dropped.
  // Add any others you notice in the debug panel.
  speechIgnore: [
    "you",
    "thank you",
    "thank you.",
    "thanks for watching",
    "thank you for watching",
    "bye",
    "subtitles by the amara.org community",
    "谢谢观看",
    "謝謝觀看",
    "字幕由Amara.org社区提供",
    "请不吝点赞 订阅 转发 打赏支持明镜与点点栏目",
    "ご視聴ありがとうございました",
    "продолжение следует",
  ],

  // CLAP's compressed 8-bit version. Must match tools/lib/clap.mjs, which made
  // data/sound-vectors.json, or live and precomputed vectors won't be comparable (step 4)
  soundDtype: "q8",

  // How the next nature sound is chosen (step 4). See src/sound/sound-choice.js.
  // CLAP ranks all library sounds by similarity to the voice. Sounds that just played
  // rest for a while; sounds not heard for a long time get a small bonus; then one of
  // the best few is drawn at random, the better the score the likelier.
  // "Rounds" here count rounds with a voice (quiet rounds don't count).
  soundChoice: {
    // Centering (see README): compare how this voice differs from an average voice
    // with how each sound differs from an average nature sound. Without it, every
    // voice matches the same one or two "voice-like" sounds. Set to false to compare.
    centering: true,
    // The average voice starts from tools/reference-voices and drifts towards the
    // current visitor: each voice round moves it this far (0 = never, 1 = jump).
    // So a visitor's own changes in tone stand out, not just "being a voice".
    voiceAdapt: 0.15,
    pool: 15, // only the 15 sounds closest to the voice can be chosen at all
    candidates: 5, // of those, the best 5 that are not resting are drawn from
    restRounds: 8, // after playing, a sound rests for 8 rounds (about 40 s of talking)
    freshBonus: 0.03, // a sound not heard for a long time (or ever) gets up to +0.03…
    freshRounds: 24, // …the full bonus after 24 rounds (about 2 min); less if heard more recently
    // How random the final draw is. Two candidates 0.02 apart: the better one is
    // about 2.7× as likely at 0.02. Smaller = almost always the best; larger = more even.
    temperature: 0.02,
  },

  // Playback of the nature sounds (step 4).
  // Each chosen sound plays for `seconds` (its 5-second clip, repeated), fading in at
  // the start and out at the end. A new one starts every round (5 s), so with 10 s
  // two sounds always overlap and blend into each other instead of switching.
  playback: {
    volume: 0.7, // 0 = silent, 1 = full (two sounds overlap, so leave some room)
    seconds: 10, // how long each chosen sound plays
    fadeSeconds: 2.5, // fade-in at the start and fade-out at the end of each
  },
};
