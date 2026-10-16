// @rust-only
// @no-engine
import { token } from "./tokens.js";
type Accent = { kind: "colour"; value: string; on: string; gnome: "red" | "blue" } | { kind: "none" };
const red = { 500: token("red.500"), 950: token("black") };
const accent: Accent = { kind: "colour", value: red[500], on: red[950], gnome: "red" };
const none: Accent = { kind: "none" };
const nested: { accent: Accent } = { accent: { kind: "colour", value: "nested", on: "text", gnome: "blue" } };
function describe(value: Accent): void {
  console.log("checked", value.kind);
  if (value.kind === "colour") { console.log("values", value.value, value.on, value.gnome); }
}
describe(accent);
describe(none);
describe(nested.accent);
