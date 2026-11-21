import { createSignal } from "./signal.js";

export function run(options) {
  const [empty] = createSignal(undefined);
  empty();
  const [content] = createSignal(options.content);
  console.log(content().length);
}
