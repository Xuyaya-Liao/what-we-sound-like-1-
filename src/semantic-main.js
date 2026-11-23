// semantic-main.js: the entry point of semantic.html, the semantic screen in its own
// window (two-screen redesign). It only listens: see src/views/semantic/semantic-view.js.

import { createBus } from "./shared/bus.js";
import { createSemanticView } from "./views/semantic/semantic-view.js";

const waiting = document.getElementById("waiting");
createSemanticView(document.getElementById("semantic-screen"), createBus(), {
  onFirstMessage: () => (waiting.hidden = true),
});
