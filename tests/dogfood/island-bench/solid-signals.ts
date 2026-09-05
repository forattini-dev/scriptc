// solid-js reactive churn in the island, driven from a static entry.
import { churn } from "./solid-work.ts";

const N = 50000;
const started = performance.now();
const observed = churn(N);
console.log(`solid-signals ${N} updates observed=${observed} ms=${Math.round(performance.now() - started)}`);
