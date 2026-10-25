// @rust-only
// @no-engine
import { renderer, plan } from "./bridge.js";
console.log("options", renderer.transmit(), renderer.transmit({ width: 3 }), plan({ width: 4 }));
function keys(value: {}): string { return Object.keys(value).join("|"); }
console.log("literal keys", keys({ width: 3, tag: "kept" }));
