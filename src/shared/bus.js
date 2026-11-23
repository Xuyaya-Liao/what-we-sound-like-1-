// bus.js: how the two screens talk to each other (two-screen redesign, step 1).
//
// The piece has two screens: the sound screen (index.html), which is also the
// "engine" — it owns the microphone, the models and the nature sounds — and the
// semantic screen (semantic.html), which only draws. For an exhibition they are two
// browser windows, one on each display. They talk through a BroadcastChannel:
// a named channel that every page of the same site, in the same browser, can post
// to and listen on. (Two different browsers, or two computers, can't hear each other.)
//
//   index.html (engine) ──publish("image", …)──▶ BroadcastChannel ──▶ semantic.html
//
// Messages are also delivered inside the page that sent them, so with ?view=both
// (both screens side by side in one window) the same code works without a second window.
//
// Message types, engine → screens (what each carries is written where it is
// published, in main.js):
//   matchTable  the category × label table, once it is built
//   level       { db }: the voice's loudness right now, ~25 times a second
//   sound       a sound was chosen: its candidates, and the vector they were compared with
//   mismatch    { value }: a new sound changed how well the image on screen fits
//   transcript  { text, language }: what Whisper heard
//   words       the whole ring of words: { labels, language, slots: [{ text, scores }
//               or null], added: [slots just filled] } (src/semantic/words.js)
//   image       an image was chosen: its file, label, mismatch, and the round's candidates
//   dark        no words for a while: sounds fade, both screens go back to dark
//   reset       a new visitor (Begin)        end   the recording has finished
// And between a screen and the engine:
//   hello { id }      a screen has just opened
//   snapshot { to }   the engine's latest state, for that screen only, so a screen
//                     opened late doesn't wait for the next round

const CHANNEL_NAME = "wwsl-screens";
const KEPT_FOR_LATECOMERS = new Set(["matchTable", "sound", "mismatch", "transcript", "words", "image"]);

// The engine side: returns publish(type, data). Remembers the latest message of each
// kind above, and answers every screen's "hello" with them.
// onPublish(type, data): also called for every message (main.js records them)
export function createPublisher(bus, { onPublish } = {}) {
  const latest = {};
  bus.on("hello", ({ id }) => bus.publish("snapshot", { ...latest, to: id }));
  return (type, data = {}) => {
    if (KEPT_FOR_LATECOMERS.has(type)) latest[type] = data;
    // After these, a screen opening late should find the screens empty too
    if (type === "dark" || type === "reset") {
      for (const kind of KEPT_FOR_LATECOMERS) if (kind !== "matchTable") delete latest[kind];
    }
    onPublish?.(type, data);
    bus.publish(type, data);
  };
}

export function createBus() {
  const listeners = new Map(); // type → [functions]
  const channel = typeof BroadcastChannel === "function" ? new BroadcastChannel(CHANNEL_NAME) : undefined;

  function deliver(type, data) {
    for (const listener of listeners.get(type) ?? []) {
      try {
        listener(data);
      } catch (error) {
        console.error(`A "${type}" listener failed:`, error); // one broken listener mustn't stop the rest
      }
    }
  }

  // Messages from the other window
  if (channel) channel.onmessage = ({ data }) => deliver(data.type, data.data);

  return {
    // Calls listener(data) for every message of this type, from this page or another
    on(type, listener) {
      if (!listeners.has(type)) listeners.set(type, []);
      listeners.get(type).push(listener);
    },

    // Sends to the other window(s) and to this page's own listeners.
    // data must be plain values: numbers, text, arrays, objects (no functions).
    publish(type, data = {}) {
      channel?.postMessage({ type, data });
      deliver(type, data);
    },
  };
}
