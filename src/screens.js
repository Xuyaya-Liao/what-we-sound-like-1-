// screens.js: sets up the screens of index.html (two-screen redesign).
// Used by both main.js (the engine) and replay-main.js (?replay=…).
//
// index.html always shows the sound screen. With ?view=both it also shows the
// semantic screen, side by side in the same window (for development, or a single
// display). For the exhibition, the semantic screen is semantic.html instead, in a
// second window on the second display; it hears the same messages through the bus.
//
// onPublish(type, data): called for everything published (main.js records it for replay)
// Returns { publish(type, data), soundView }.

import { createBus, createPublisher } from "./shared/bus.js";
import { createSoundView } from "./views/sound/sound-view.js";
import { createSemanticView } from "./views/semantic/semantic-view.js";

export function setupScreens({ onPublish } = {}) {
  const bus = createBus();
  // Before any screen exists, so a screen's very first "hello" is answered
  const publish = createPublisher(bus, { onPublish });

  if (new URLSearchParams(location.search).get("view") === "both") {
    document.body.classList.add("view-both");
    const semanticScreen = document.getElementById("semantic-screen");
    semanticScreen.hidden = false;
    createSemanticView(semanticScreen, bus);
  }
  const soundView = createSoundView(document.getElementById("sound-screen"), bus);
  return { publish, soundView };
}
