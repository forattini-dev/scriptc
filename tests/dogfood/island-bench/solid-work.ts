import { createEffect, createMemo, createRoot, createSignal } from "solid-js";

export function churn(n: number): number {
  let observed = 0;
  createRoot((dispose) => {
    const [count, setCount] = createSignal(0);
    const doubled = createMemo(() => count() * 2);
    const label = createMemo(() => `n=${doubled()}`);
    createEffect(() => {
      observed += label().length;
    });
    for (let i = 1; i <= n; i++) setCount(i);
    dispose();
  });
  return observed;
}
