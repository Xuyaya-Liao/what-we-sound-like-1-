// replay.js: records what the screens were shown, and plays it back later
// (two-screen redesign, step 1).
//
// Designing the visuals by speaking into the microphone every time is slow, and no
// two tries are the same. Instead, every message the engine sends to the screens
// (src/shared/bus.js) is also recorded, with its time. The debug panel's "Replay"
// button downloads the recording; then
//   http://localhost:5510/?replay=recordings/my-test.json
// plays it back: the same rounds, the same sounds, the same images, at the same
// pace, without the microphone and without loading any model. Add &loop to repeat.
// This is real data from a real visit, so what you tune against is what visitors see.
//
// What can't be replayed: the live input spectrum (it needs the raw microphone
// samples, about 2 MB a minute), so the ring stays empty during a replay.

const FORMAT = "wwsl-replay";
const RECORDED = new Set(["level", "sound", "mismatch", "transcript", "words", "image", "matchTable", "dark", "reset", "end"]);
const LEVEL_EVERY_MS = 100; // loudness arrives ~25 times a second; 10 is plenty for the visuals
const MAX_EVENTS = 50000; // about 80 minutes; the oldest are dropped after that
const LONGEST_PAUSE_MS = 3000; // a long pause in the recording (start screen…) plays as 3 s

export function createReplayRecorder() {
  let startedAt; // performance.now() when recording started; undefined = not recording
  let events = [];
  let lastLevelAt = -Infinity;

  return {
    get count() {
      return events.length;
    },

    // Starts (or restarts) recording, beginning with any messages given
    // (e.g. the match table, which was sent before recording began)
    start(initial = []) {
      startedAt = performance.now();
      events = [];
      lastLevelAt = -Infinity;
      for (const [type, data] of initial) if (data) this.add(type, data);
    },

    add(type, data) {
      if (startedAt === undefined || !RECORDED.has(type)) return;
      const t = Math.round(performance.now() - startedAt);
      if (type === "level") {
        if (t - lastLevelAt < LEVEL_EVERY_MS) return;
        lastLevelAt = t;
      }
      events.push({ t, type, data });
      if (events.length > MAX_EVENTS) events.shift();
    },

    toJson() {
      return JSON.stringify({ format: FORMAT, version: 1, recordedAt: new Date().toISOString(), events });
    },
  };
}

// Downloads and checks a recording. Returns its events.
export async function loadReplay(url) {
  const response = await fetch(url, { cache: "no-cache" });
  if (!response.ok) throw new Error(`could not load ${url} (HTTP ${response.status})`);
  const recording = await response.json();
  if (recording.format !== FORMAT || !Array.isArray(recording.events)) {
    throw new Error(`${url} is not a recording made with the debug panel's Replay button`);
  }
  return recording.events;
}

// Plays events back at their recorded pace, calling onEvent(type, data) for each.
// Returns { stop() }.
export function playReplay(events, { onEvent, onEnd, loop = false }) {
  // Shorten long pauses, so a recording that sat on the start screen for a minute
  // doesn't play a minute of nothing
  const times = [];
  let shift = 0;
  events.forEach((event, i) => {
    const gap = i ? event.t - events[i - 1].t : event.t;
    if (gap > LONGEST_PAUSE_MS) shift += gap - LONGEST_PAUSE_MS;
    times.push(event.t - shift);
  });

  let timer;
  let stopped = false;

  function run() {
    const startedAt = performance.now();
    let next = 0;
    const step = () => {
      if (stopped) return;
      const elapsed = performance.now() - startedAt;
      while (next < events.length && times[next] <= elapsed) {
        onEvent(events[next].type, events[next].data);
        next++;
      }
      if (next < events.length) {
        timer = setTimeout(step, times[next] - elapsed);
      } else if (loop) {
        timer = setTimeout(run, 1000); // a short breath before starting again
      } else {
        onEnd?.();
      }
    };
    step();
  }

  run();
  return {
    stop() {
      stopped = true;
      clearTimeout(timer);
    },
  };
}
