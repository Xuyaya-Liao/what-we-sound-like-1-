// library.js: loads the asset list (data/manifest.json) that npm run build:assets wrote,
// and the sound-category table (config/sound-categories.json, hand-edited, no build step).
// Both pages use loadLibrary(). loadSoundCategories() is only for the visuals (step 10).

// "async" means this function waits for something slow (here: reading a file
// over the network). Whoever calls it writes "await loadLibrary()" to wait for the result.
export async function loadLibrary() {
  // "no-cache": always ask the server whether the file changed (after npm run build),
  // instead of silently reusing an old copy the browser kept
  const response = await fetch("./data/manifest.json", { cache: "no-cache" });
  if (!response.ok) {
    throw new Error(`Could not load data/manifest.json (HTTP ${response.status}). Run npm run build:assets first.`);
  }
  return response.json();
}

// The sound library's categories (e.g. "rain", "thunder"), with a short English
// description of each — see config/sound-categories.json. Used to compare a chosen
// sound's category with a chosen image's label (step 10's "mismatch").
export async function loadSoundCategories() {
  const response = await fetch("./config/sound-categories.json", { cache: "no-cache" });
  if (!response.ok) throw new Error(`Could not load config/sound-categories.json (HTTP ${response.status}).`);
  const { categories } = await response.json();
  return categories;
}
