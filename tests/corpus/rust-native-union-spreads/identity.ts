type Spec = { kind: "a"; items: string[]; callback: (s: string) => string } | { kind: "b"; nested: { value: string } };
type Out = Spec & { flag: boolean };
function wrap(pr: Spec): Out { return { ...pr, flag: true }; }
const items = ["one"];
const callback = (s: string): string => s + "!";
const a: Spec = { kind: "a", items, callback };
const out = wrap(a);
const original: any = a; const copied: any = out;
console.log("case", copied === original);
if (out.kind === "a") { out.items.push("two"); console.log("case", out.items === items, out.callback === callback, items.join("|"), out.callback("ok")); }
const nested = { value: "before" };
const b = wrap({ kind: "b", nested });
if (b.kind === "b") { b.nested.value = "after"; console.log("case", b.nested === nested, nested.value); }
