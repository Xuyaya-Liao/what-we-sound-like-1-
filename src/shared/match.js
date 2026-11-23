// match.js: how well a sound category and an image label go together (step 10).
//
// The table itself is built once by the text model, in src/workers/speech-worker.js
// (buildMatchMatrix): { categories: [ids], labels: [ids], values: [[0–1]] }, where
// 1 = the best pair in the whole table and 0 = the worst. It is plain data, so the
// engine can send it to the screens (src/shared/bus.js); each side turns it into
// this lookup function. Mismatch is 1 minus the result.

// Returns match(categoryId, labelId) → 0–1. Until the table is known, or for an id
// it has never seen, a neutral middle value.
export function createMatchLookup(table) {
  if (!table) return () => 0.5;
  const categoryIndex = new Map(table.categories.map((id, i) => [id, i]));
  const labelIndex = new Map(table.labels.map((id, i) => [id, i]));
  return (categoryId, labelId) => {
    const i = categoryIndex.get(categoryId);
    const j = labelIndex.get(labelId);
    return i === undefined || j === undefined ? 0.5 : table.values[i][j];
  };
}
