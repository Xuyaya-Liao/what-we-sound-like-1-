// worker-client.js: makes talking to a Web Worker feel like calling a function.
//
// What is a Web Worker?
// A page normally does everything on one "main thread": drawing p5, reacting to
// clicks, and running our code. Running a model takes a few hundred milliseconds,
// and during that time the main thread can do nothing else, so the visuals would
// freeze. A Web Worker is a second JS program running alongside, on its own thread.
// The model runs there; the page keeps drawing smoothly.
//
// The catch: the two sides can't touch each other's variables. They only exchange
// messages (postMessage / onmessage). This file hides that behind a promise:
//
//     const clap = createWorkerClient(new URL("./sound-worker.js", import.meta.url));
//     const { vector } = await clap.call("embed", { samples });
//
// Each call gets a number (id); the worker sends the id back with its answer,
// so the right "await" receives the right answer.

export function createWorkerClient(url, { onProgress } = {}) {
  const worker = new Worker(url, { type: "module" }); // "module": the worker may use import too
  const waiting = new Map(); // id → { resolve, reject } of calls still waiting for an answer
  let nextId = 0;

  worker.onmessage = ({ data }) => {
    if (data.type === "progress") {
      onProgress?.(data); // download progress while the model loads
      return;
    }
    const call = waiting.get(data.id);
    waiting.delete(data.id);
    if (data.error) call?.reject(new Error(data.error));
    else call?.resolve(data.result);
  };

  // A crash inside the worker (e.g. a typo) fails every waiting call instead of hanging forever.
  worker.onerror = (event) => {
    console.error(event);
    for (const call of waiting.values()) call.reject(new Error(event.message || "The worker crashed"));
    waiting.clear();
  };

  return {
    // Sends { id, type, ...payload } and resolves with the worker's result.
    call(type, payload = {}) {
      const id = nextId++;
      return new Promise((resolve, reject) => {
        waiting.set(id, { resolve, reject });
        worker.postMessage({ id, type, ...payload });
      });
    },
  };
}
