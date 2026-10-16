// @rust-only
// @no-engine
import { DirtyFlags as flags, original, content } from "./flags.js";
console.log("flags", flags.NONE, flags.CONTENT, flags.STYLE, flags.CHILDREN, flags.FORCE_FULL);
console.log("reverse", flags[0] === "NONE", flags[1] === "ALIAS", flags[-1] === "NEGATIVE");
console.log("identity", original === flags, original.CHILDREN, flags.LABEL === "dirty", content());
console.log("missing", flags[99] === undefined);
const ordinary: Record<string, number | string | undefined> = { value: 3, label: "data" };
console.log("ordinary dictionary", ordinary.value === 3, ordinary.label === "data");
