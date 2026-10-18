import { pass, inspect, optionalCopy } from "./bridge.js";
type Spec = { kind: "a"; text: string } | { kind: "b"; count: number };
type Out = Spec & { flag?: true };
function wrap(pr: Spec): Out { return { ...pr, flag: true }; }
console.log("case", inspect(wrap(pass({ kind: "a", text: "hello" }))), inspect(wrap(pass({ count: 7, kind: "b" }))));
const optional = optionalCopy({ value: "bridge" });
if (optional !== undefined) console.log("case", optional.value === "bridge", Object.keys(optional).join("|"));
