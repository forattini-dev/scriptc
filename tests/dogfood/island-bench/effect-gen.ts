// Effect fibers in the island: the entry stays static and calls into the
// island module that owns the Effect program (the frontier shape a real
// Effect application takes).
import { runFibers } from "./effect-work.ts";

const N = 2000;
const started = performance.now();
const sum = await runFibers(N);
console.log(`effect-gen ${N} fibers sum=${sum} ms=${Math.round(performance.now() - started)}`);
