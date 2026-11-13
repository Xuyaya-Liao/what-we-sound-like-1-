# What We Sound Like, What We Say

The same spoken words, understood by a machine in two ways:

- **How we say it**: CLAP listens to the sound itself, finds the most similar nature recording, and plays it.
- **What we say**: Whisper turns the speech into text, an LLM picks one label from a label list, and an image with that label is shown.

The site processes one round every 5 seconds and updates in real time.

## How to run it

For security, browsers do not let a page opened by double-clicking (a `file://` address) load modules. Open it through a local server instead, using either option:

- **VS Code Live Server** (recommended, the way the earlier demo ran): open the `what-we-sound-like` folder in VS Code, right-click `index.html`, choose **Open with Live Server**.
- **Python**: open a terminal in this folder, run `python -m http.server 5510`, then open <http://localhost:5510> in the browser.

Use Chrome or Edge. Headphones are recommended, so the microphone doesn't pick up the
nature sounds the piece plays.

**Bluetooth headphones: listen with them, but don't use their microphone.** Using a
Bluetooth headset's mic switches it into "hands-free" (phone call) mode: playback drops
to muffled phone quality, and on some headsets the browser receives no signal at all
(the debug panel shows about −170 dB, always "quiet"). Pick the computer's built-in
microphone in the debug panel's Microphone menu instead. Wired headphones avoid all this.

### The loading bar

The start screen downloads the three models (CLAP, Whisper, the text model) as soon as
the page opens, and shows one bar for all of them, measured in bytes: about 580 MB on a
computer that runs Whisper small on the GPU, about 250 MB with Whisper base on the CPU.
**Begin** (and choosing a recording) only works once the bar is full and every model has
started; until then the button is greyed out. Only the first visit downloads; after that
the browser keeps the models and the bar fills in a few seconds. For an exhibition, open
the page once beforehand.

If the page looks broken after the code changed (for example no loading bar), the browser
is still showing the old `index.html`: reload with Ctrl+Shift+R.

### Testing without speaking

Click **Begin** to use the microphone, or choose a recording under it. For repeatable
tests, put a recording in the address bar, and **Begin** plays that instead:

- <http://localhost:5510/?input=test-audio/en-water-storm.wav> (English, about 20 s)
- <http://localhost:5510/?input=test-audio/zh-storm-water.wav> (Mandarin, about 20 s)

Both are synthetic voices (Windows text-to-speech) with a 7-second pause in the middle,
to check that quiet rounds are detected. Any audio file in `test-audio/` works the same way.
Add `&loop` to play the recording over and over, for long tests:
<http://localhost:5510/?input=test-audio/zh-storm-water.wav&loop>.

Press **D** to show or hide the debug panel. The top shows the input, the model status
and the sound playing now. Below is one block per 5-second round: when it started, how
loud it was, whether it counts as voice or quiet, a ▶ button to hear exactly what was
captured, and the results:

```
#2 5.0 s · -30 dB · voice · prep 3 ms                                  ▶
♪ Beryl Spring · CLAP 581 ms · 1 resting     ← sound drawn, CLAP time, close matches skipped (resting)
   34%  0.248 (0.61) +0.030  rain · Rain.ogg      ← top 3 candidates: chance of being drawn,
   27%  0.243 (0.24) +0.030  geothermal · Beryl Spring ✓   centered score (plain score),
   23%  0.240 (0.19) +0.012  insects · cricket             freshness bonus, category · title
```

How the next sound is chosen (all set in `src/config.js` under `soundChoice`):

1. Only the 15 sounds closest to the voice can be chosen at all (`pool`).
2. A sound that just played **rests** for 8 voice rounds, about 40 s (`restRounds`).
3. Of the rest, the best 5 are candidates (`candidates`). A sound not heard for a long
   time, or never, gets a small **freshness bonus**, up to +0.03 after 2 minutes (`freshBonus`, `freshRounds`).
4. One candidate is **drawn at random**: the better the score, the likelier, but not certain
   (`temperature`; smaller = almost always the best).

Each chosen sound plays for 10 seconds (its 5-second clip twice), fading in over 2.5 s
and out over the last 2.5 s. A new one starts every round, so two sounds always overlap
and blend instead of switching. Quiet rounds start nothing new, so in silence the last
sound simply fades away. Length, fades and volume are under `playback`.

Each round block also shows the meaning path:

```
“我喜欢蓝色” · zh · heard 10 s · Whisper 931 ms   ← what Whisper heard, its language, seconds listened to, time
→ pollinators 0.29 · autumn 0.21 · lightning 0.20  (local, 6 ms)   ← closest labels, best first
⇒ still_water  (LLM, 640 ms · 712 + 4 tokens)       ← the LLM's choice, when it is on (step 6)
▣ still_water · Mirror Lake.jpg  (5 of 7 left in the bag)   ← the image shown (step 7)
```

The box at the top of the panel takes a typed sentence (any language) and runs it through
the same meaning path, without speaking.

### The meaning path, and two things to know about Whisper

Every 5 seconds Whisper turns the last 10 seconds (the previous round and this one) into
text in the language spoken, never translated. Hearing 10 s means a sentence cut in half at
a round boundary is heard whole the next time; the price is that a sentence can show up in
two rounds in a row. After a quiet round it hears only the new 5 s (`speech.listenSeconds`).
A multilingual text model (`paraphrase-multilingual-MiniLM`) then compares that text with
each label's English name and description and picks the closest. This local answer is the
fallback: in step 6 an LLM makes the choice, which can follow associations ("I like the
colour blue" → water or sky) that the text model can't.

- **Language detection.** transformers.js 4.3.2 cannot detect the language: without one it
  assumes English, and Whisper then translates. `src/workers/speech-worker.js` works around
  this by letting Whisper choose its own language token (the comments there explain how).
  English and Mandarin are both detected correctly.
- **Which Whisper: GPU or CPU.** If the browser has WebGPU (the graphics card) and the card
  does 16-bit maths, `whisper-small` runs there: about 1–2 s per round, and Mandarin is
  nearly always right (湖面很安静，倒映着每一朵云 ✓). Otherwise, or if loading on the GPU
  fails, `whisper-base` runs on the CPU: about 2.5–3.5 s, and its Mandarin is approximate
  (雷声越来越响 → 雷生越來越想). The debug panel's model line says which one is running,
  e.g. `Whisper ready (small · GPU)`. Both are under `speech` in `src/config.js`. small is a
  bigger first download (about 2.5 minutes here; see "The loading bar"); after that the browser keeps it. Tested
  on 2026-11-12; `whisper-large-v3-turbo` (about 1.4 GB) was too big to download for visitors.
- **Traditional characters.** Whisper sometimes writes Mandarin in traditional characters.
  This doesn't matter for the meaning path.
- **Hallucinations.** In noise or silence Whisper sometimes "hears" stock phrases ("you",
  "Thank you for watching"…). These are dropped (`speechIgnore` in `src/config.js`).

### The LLM (step 6), and how not to waste tokens

With the LLM on, each transcript is also sent to an LLM through OpenRouter
(`anthropic/claude-haiku-5.5`, set under `llm` in `src/config.js`). It gets the label table
(id and description of every label in `config/labels.json`) and the transcript as heard, and
answers with one label id. Its answer replaces the local one (`⇒` in the debug panel); if it
fails, is too slow (4 s) or answers something that isn't a label, the local one stays.
The prompt is in `src/semantic/llm-label.js`.

Thinking is switched off (`reasoning: "none"` in `src/config.js`). By default this model
thinks before answering; with only 10 answer tokens it used them all on thinking and
replied with nothing ("LLM failed: answered “”"). Picking a label doesn't need thinking.

Every question costs tokens, so:

- **It is off by default** (`llm.mode: "off"`). To test it, add `?llm=on` to the address:
  <http://localhost:5510/?llm=on>. It can be combined with a test recording:
  `?llm=on&input=test-audio/zh-storm-water.wav`.
- **The API key is never in the code.** With the LLM on, the debug panel shows a box: paste
  the key there and press Enter. It is kept in this browser only (`localStorage`); "Forget
  key" removes it. A key in the code could be read by every visitor. For the public site,
  step 12 adds a small relay server that holds the key instead.
- **Answers are remembered.** The same sentence is never asked twice, even after a reload,
  so replaying a test recording costs nothing the second time. A sentence that is part of the
  last one asked (the 10-second window hears things twice) reuses that answer.
- **Quiet, unclear and ignored rounds are never sent.**
- **The panel counts what was used**: questions, tokens and dollars during this visit.

Cost: one question is about 700 tokens, nearly all of it the label table. At the prices on
2026-11-12 ($0.10 per million prompt tokens, $0.50 per million answer tokens) that is about
$0.00007, so 1000 questions cost about $0.07, and an hour of non-stop talking (720 rounds)
about $0.05. Use a separate key for development with a small credit limit (set on the
OpenRouter website), so testing can never use up the exhibition's budget.

### The images (step 7)

Once a round's label is settled (the LLM's when it is on, otherwise the local one), that
label's next image fades in over the last one (`images.fadeSeconds`) and zooms in very
slowly. So the image changes once per round with speech, and stays during silence.

Which image: every label has a **shuffle bag**, all its images in random order. Each time
the label comes up, the next one is taken out; when the bag is empty it is refilled and
shuffled again. So a label shows every one of its images before repeating any. On top of
that, the last few images shown are avoided (`images.recent`, but at most half of a
label's images), so a refilled bag never starts with the image that is still on screen.
With 5 images the same one comes back after 3 rounds at the earliest; with 16, after 6.
Tested on 2026-11-12. The code is in `src/image/image-choice.js`.

The images come from `data/manifest.json`, which lists each image's label. To add or move
images, change the assets and re-run `npm run build:assets`.

### Timing and stability (step 8)

The debug panel shows how the piece is keeping up, in a summary line under "♪ latest":

```
10:12 · 122 rounds (94 voice) · sound avg 0.6 s, max 0.8 · image avg 1.4 s, max 4.3 · skipped 0 · page memory 63 MB
```

Times count from the moment a 5-second segment is cut: **sound** until the nature sound
starts, **image** until the image starts fading in (with the LLM on, this includes its
answer). Each round's head line shows its own times too. A path that takes longer than a
round makes the next round **skip** that path, rather than queueing rounds up and falling
further and further behind; "skipped" counts these. "page memory" (Chrome and Edge only)
counts the page, not the models' workers.

What keeps a long session steady:

- **Waiting for the LLM doesn't hold up Whisper.** Whisper is free for the next round as soon
  as it has written the text; the LLM's answer (up to 4 s) arrives on its own.
- **An older sentence never replaces a newer image.** If a later round's label is settled
  first, the earlier one's answer is noted ("a newer sentence was understood first") and dropped.
- **Decoded nature sounds are capped** at the 40 most recently used (about 1 MB each), so
  memory doesn't keep growing as more of the library gets played.
- **The sound engine restarts itself** if something outside the page stops it (for example
  the system switching audio devices), with a note in the debug panel.

Tested on 2026-11-12: 10 minutes of the looping Mandarin recording (LLM off, Whisper small
on the GPU): 122 rounds, 0 skipped, sound 0.6 s on average (max 0.8), image 1.4 s (max 4.3,
the very first round while Whisper warms up), page memory between 33 and 66 MB.

Still to test with a real microphone and **speakers** (not headphones): stay silent for a
minute while nature sounds play. The rounds should stay "quiet". If the microphone picks the
nature sounds up as "voice", the piece keeps answering itself.

### The experiment log (step 9)

Every round, and every typed sentence, is written down as one row: the time, the input,
the tag, loudness, the sound chosen with its score and the top 3, the transcript and its
language, the local labels and the LLM's choice, the image, and how long each part took.
The row under the summary line in the debug panel controls it:

```
Log: 42 rows  JSON  CSV  Clear  · tag “whispering”
[Tag for the next rounds, e.g. whispering, then Enter]
```

- **JSON** downloads everything, plus the settings it was recorded under (which Whisper,
  LLM on or off, the sound-choice settings…), so results from different days can be compared.
- **CSV** downloads one row per round, for Excel or Google Sheets. Chinese text shows correctly
  in Excel.
- **Clear** empties the log. **The log is kept in memory only: reloading the page empties
  it too**, so download before reloading.

**For the reading experiment** (the same text read in different ways): type a tag, such as
`normal`, `whispering`, `shouting` or `singing`, and press Enter before each reading. Every
row after that carries the tag, until another one is entered (an empty Enter clears it). In
the spreadsheet, filter or sort by the `tag` column to compare which sounds, labels and
images each way of speaking led to. The code is in `src/log/round-log.js`.

Tested on 2026-11-12 with the Mandarin recording and a typed sentence: the JSON and CSV
files contained every field above.

## What each file is for

```
what-we-sound-like/
├─ index.html          The piece: lays out the page, loads p5 and our program
├─ credits.html        Library and credits: every image and sound with author and license
├─ style.css           Looks: colors, fonts, positions
├─ src/                The website's program (runs in the browser)
│  ├─ main.js          Main entry of the piece; every part is plugged in from here
│  ├─ config.js        All adjustable settings (rhythm, model names…)
│  ├─ library.js       Loads data/manifest.json
│  ├─ session-stats.js Counts rounds, timings and skips for the debug panel's summary line
│  ├─ credits.js       Fills the credits page
│  ├─ audio/
│  │  ├─ capture.js         Microphone or recording → one segment every 5 s
│  │  ├─ capture-worklet.js Runs on the audio thread, collects raw samples
│  │  ├─ resample.js        Converts a segment to 48 kHz (CLAP) and 16 kHz (Whisper)
│  │  └─ player.js          Plays each chosen sound for 10 s with fades; layers overlap
│  ├─ sound/
│  │  └─ sound-choice.js    Ranks library sounds against the voice, picks one (rest, bonus, draw)
│  ├─ semantic/
│  │  ├─ transcript.js      Tidies Whisper's text, drops phrases it hears in noise
│  │  └─ llm-label.js       Asks the LLM for a label: prompt, key, remembered answers
│  ├─ image/
│  │  └─ image-choice.js    Picks a label's next image: shuffle bag, recent ones avoided
│  ├─ log/
│  │  └─ round-log.js       Records every round; downloads the log as JSON or CSV
│  ├─ workers/
│  │  ├─ worker-client.js   Lets the page call a Web Worker like a function
│  │  ├─ sound-worker.js    Runs CLAP off the main thread
│  │  └─ speech-worker.js   Runs Whisper and the multilingual text model
│  └─ ui/
│     └─ debug-panel.js The panel in the corner (press D)
├─ config/
│  ├─ labels.json      The label table (hand-edited): what the LLM may choose from
│  └─ excluded.json    Images or sounds to leave out, with the reason (hand-edited)
├─ tools/              Offline tools (run on your computer with Node)
│  ├─ build-assets.mjs  Copies a dataset snapshot into assets/ (evening out sound loudness)
│  │                    and writes data/manifest.json
│  ├─ check-speech.mjs  Finds sounds with human voices in them (AST), excludes them
│  ├─ build-vectors.mjs Runs CLAP on every library sound, writes data/sound-vectors.json
│  ├─ try-sound.mjs     Lists the library sounds closest to any WAV file
│  ├─ reference-voices/ Recordings of people talking, averaged into "an average voice" (centering)
│  └─ lib/              Shared helpers: wav.mjs (read/write WAV), loudness.mjs, clap.mjs
├─ test-audio/         Recordings for repeatable tests (?input=…)
├─ assets/             Images and sounds for the site (generated, not in git)
├─ data/
│  ├─ manifest.json     The asset list the site reads (generated)
│  └─ sound-vectors.json One CLAP vector per library sound (generated)
├─ server/             LLM relay that hides the API key (added in step 12)
└─ package.json        npm dependencies and commands of the offline tools; the site itself needs no npm
```

## Rebuilding the asset library

`assets/` and `data/` are generated from a dataset snapshot exported by
`dataset-tools/curate.py` (in the earlier demo folder). After editing `config/labels.json`,
or when a new snapshot is ready, run in this folder:

```
npm run build
```

This runs three steps, which can also be run one at a time:

- `npm run check:speech` listens to every sound in the snapshot with AST, a model that
  recognises 527 kinds of sound (AudioSet), and excludes recordings with people talking,
  singing or laughing in them: a nature sound with voices matches every visitor and gets
  chosen over and over. It rewrites only the entries in `config/excluded.json` that start
  with `auto:`; entries you add by hand stay. `npm run check:speech -- --report` only prints
  the scores. Results are cached, so only new sounds are checked again.
- `npm run build:assets` checks every file in the snapshot (known label, allowed license,
  file exists), copies the images, evens out the loudness of the sounds (target −23 LUFS),
  and writes `data/manifest.json`. To use a different snapshot:
  `npm run build:assets -- "path/to/snapshot"`.
- `npm run build:vectors` runs CLAP on every sound and on the reference voices, and writes
  `data/sound-vectors.json`. The first run downloads the model and takes a few minutes;
  later runs reuse a cache and only compute new or changed sounds. It ends with two checks:
  1. how often a sound's nearest neighbour belongs to the same category;
  2. how many different sounds come first for the reference voices, without and with centering.

If you hear voices in a sound that the speech check missed, add its id (or its source id,
like `fs-860231`, for every clip from that recording) to `config/excluded.json` by hand,
with the reason, and run `npm run build` again.

The speech check's threshold (0.2, in `tools/check-speech.mjs`) was set on 2026-11-11 from
two recordings confirmed by ear: "Icy Water" scored 0.86 and the Alishan dawn ambience 0.35.
Three more were excluded (0.84, 0.40, 0.23); the next highest scored 0.17. Recordings just
below the threshold (dolphins, a loon, "strong windy night", a mud pool "with background
sounds") are worth a listen.

To hear which library sounds a recording is closest to (the same thing the site does
every 5 seconds with the microphone):

```
npm run try-sound -- "path/to/recording.wav"
```

### Why precompute?

The library sounds never change while the site runs, so their CLAP vectors never change
either. Computing them in each visitor's browser would mean downloading all ~90 MB of
sounds and running CLAP 186 times (a minute or two of waiting) before anything happens,
with identical results for everyone. Instead they are computed once here and shipped as
one small file. The site then only runs CLAP once per round, on the visitor's voice.

This only works if the browser uses exactly the same model and settings (`q8`) as
`tools/lib/clap.mjs`. Checked on 2026-11-11: browser and Node vectors for the same clip
agree to a similarity of 0.996–0.9995.

### Centering

With plain similarity, almost every voice matched the same one or two library sounds.
Every voice shares a big "someone is talking" component, and every library sound a big
"field recording" component; plain scores are dominated by those shared parts, so the
library sounds that happen to be most voice-like win every time.

Centering subtracts the shared parts before comparing:

- each library sound minus the average library sound = how it differs from nature sounds in general;
- the voice minus an average voice = how this voice, right now, differs from speech in general.

The average voice starts from the recordings in `tools/reference-voices/` and then drifts
towards the current visitor (`voiceAdapt` in `src/config.js`), so a visitor's own changes
of tone stand out. With 23 reference voice windows, the number of different first choices
went from 2 (plain) to 11 (centered). The debug panel shows the centered score with the
plain one in brackets; `centering: false` in `src/config.js` switches back, for comparison.

`tools/reference-voices/` currently holds synthetic voices (Windows text-to-speech).
Recordings of real people, in different languages and moods, will make the average voice
more representative: add WAV files there and run `npm run build:vectors`.

## Concept cheat sheet

| Term | Meaning |
|---|---|
| Module | A JS file can hand things out with `export`, and another file takes them with `import`. This lets code be split into files by purpose. |
| CDN | A public library host. `<script src="https://cdn.jsdelivr.net/...">` loads a library from a CDN, no download needed. |
| p5 instance mode | The professor's examples use global mode (writing `setup()` directly). In a module it becomes `new p5(p => { p.setup = ... })`. Same abilities, just with `p.` in front. |
| Local server | Your own computer pretending to be a website, so the browser can reach the files at `http://localhost`. |
| Node / npm | Node runs JS on your computer (not in a browser). npm is its package manager. We only use it for the offline tools. |
| `npm run build:assets` | Runs the command named `build:assets` in `package.json`, which is `node tools/build-assets.mjs`. A shortcut so you don't have to remember the path. |
| JSON | A text format for structured data (lists and named fields). `manifest.json` and `labels.json` are JSON. |
| `async` / `await` | Some things take time (loading a file, running a model). `await` waits for them to finish before the next line runs, without freezing the page. |
| `fetch` | How browser code downloads a file, e.g. `fetch("./data/manifest.json")`. |
| Vector / embedding | CLAP turns 5 seconds of sound into a list of 512 numbers. Similar-sounding clips get similar lists. |
| Cosine similarity | How alike two vectors are: 1 = pointing the same way (very similar), around 0 = unrelated. |
| LUFS | A loudness unit that follows how loud something *feels*, not just its peak. −23 LUFS is the broadcast standard; higher (less negative) is louder. |
| Sample rate | How many numbers describe one second of sound. CLAP expects 48000, Whisper 16000; the browser records at whatever the sound card uses. |
| dBFS | Decibels relative to the loudest possible value: 0 is the maximum, −20 is close speech, −60 a quiet room. The debug panel's level column uses it. |
| AudioContext | The browser's sound engine. Sources (mic, files) and effects are "nodes" connected into a chain that ends at the speakers. |
| AudioWorklet | A small piece of code that runs on the browser's separate audio thread, so it can touch every sample without making the sound stutter. |
| Web Worker | A second JS program running next to the page, on its own thread. Models run there so the visuals never freeze. The two sides only talk by sending messages. |
| Promise | A value that arrives later (e.g. a model's answer). `await` waits for it. |
| Envelope | How a sound's volume changes over its life: here, fade in, hold, fade out. Overlapping envelopes make the sounds blend. |
| Hub | A library item that sits close to almost everything, so it keeps winning. Here: sounds with people talking in them. |
| Token | A word piece. Whisper writes its answer one token at a time; a few special ones at the start say the language and the task. |
| Logits processor | A small function that sees the score of every possible next token and may change them before the model picks one. Used here to let Whisper choose the language. |
| Hallucination | Text a model produces that isn't in its input, like Whisper "hearing" "Thank you for watching" in silence. |
| Centering | Subtracting the average vector before comparing, so only what is particular about each item counts. |

## Progress

- [x] Step 0 · Project skeleton
- [x] Step 1 · Asset manifest
- [x] Step 2 · Precomputed sound vectors
- [x] Step 3 · Input (microphone, one chunk every 5 s)
- [x] Step 4 · Sound path
- [x] Step 5 · Meaning path (local)
- [x] Step 6 · Meaning path (LLM) (the relay that hides the key moves to step 12)
- [x] Step 7 · Image selection
- [ ] Step 8 · Timing and stability (built and run for 10 minutes; the speaker test is left)
- [x] Step 9 · Experiment logging
- [ ] Step 10 · Visuals v1 (minimum deliverable)
- [ ] Step 11 · Visual iterations + dataset finalization
- [ ] Step 12 · Deployment
- [ ] Step 13 · Audience testing and delivery
