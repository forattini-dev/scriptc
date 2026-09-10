// scriptc-only (deliberately divergent: Node has a real wasm engine —
// this pins the island's throwing-stub surface instead).
async function run(): Promise<void> {
  const m = await import("./wasmprobe.mjs");
  const probed: string = await m.probe();
  console.log(probed);
  console.log(m.abortShape());
  console.log(m.validated());
  const surface: string = await m.surface();
  console.log(surface);
}
run();
