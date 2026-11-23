// replay-main.js: the entry point of index.html when the address has ?replay=…
// (two-screen redesign, step 1). See src/shared/replay.js for what a recording is.
//
//   http://localhost:5510/?replay=recordings/my-test.json&view=both
//
// Instead of the engine (microphone, models, nature sounds), this plays a recording
// back into the screens: the same messages, at the same pace. Nothing is downloaded
// except the recording and the images, so it starts in a second. No sound plays.
// &loop plays it over and over. semantic.html in a second window follows along too.

import { loadReplay, playReplay } from "./shared/replay.js";
import { setupScreens } from "./screens.js";

const params = new URLSearchParams(location.search);
const url = params.get("replay");
const startScreen = document.getElementById("start-screen");
const startButton = document.getElementById("start-button");
const statusLine = document.getElementById("status");
document.getElementById("loading").hidden = true;
document.querySelector(".choose-recording").hidden = true;

const { publish } = setupScreens();

try {
  const events = await loadReplay(url);
  const seconds = Math.round((events.at(-1)?.t ?? 0) / 1000);
  const rounds = events.filter((event) => event.type === "image").length;
  statusLine.textContent = `Replay · ${url} · ${rounds} images over ${seconds} s${params.has("loop") ? " · looping" : ""}`;
  startButton.textContent = "Play";
  startButton.disabled = false;
  startButton.onclick = () => {
    startScreen.hidden = true;
    playReplay(events, {
      loop: params.has("loop"),
      onEvent: publish,
      onEnd() {
        statusLine.textContent = "The replay has finished.";
        startScreen.hidden = false;
      },
    });
  };
} catch (error) {
  console.error(error);
  statusLine.textContent = `Could not replay: ${error.message}`;
}
