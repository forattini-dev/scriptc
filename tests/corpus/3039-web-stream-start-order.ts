// Start promise assimilation preserves the relative order of microtasks and pull.
new ReadableStream<number>({
  start() { console.log("start"); return Promise.resolve(); },
  pull(controller) { console.log("pull"); controller.close(); },
});
queueMicrotask(() => console.log("microtask"));
console.log("sync");
