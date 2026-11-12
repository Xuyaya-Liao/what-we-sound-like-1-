// library.js: loads the asset list (data/manifest.json) that npm run build:assets wrote.
// Both pages use it: the main piece (to choose sounds and images) and the credits page.

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
