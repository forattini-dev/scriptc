import { createMemo, createRoot, createSignal } from "solid-js";

// Synchronous observation: memos recompute on read, so the loop's reads
// measure the signal graph without depending on effect scheduling.
export function churn(n: number): number {
  let observed = 0;
  createRoot((dispose) => {
    const [count, setCount] = createSignal(0);
    const doubled = createMemo(() => count() * 2);
    const label = createMemo(() => `n=${doubled()}`);
    for (let i = 1; i <= n; i++) {
      setCount(i);
      observed += label().length;
    }
    dispose();
  });
  return observed;
}
