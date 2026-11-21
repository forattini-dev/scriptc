// @rust-only
// @no-engine
export {};

type Callback = (body: Record<string, unknown>) => unknown;
const callbacks: Readonly<Record<string, Callback>> = {
  value: (body) => body.value,
  text: (body) => String(body.value),
};
const selected = callbacks["value"];
console.log("callback-dictionary", selected({ value: 4 }) === 4);
