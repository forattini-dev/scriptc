// @rust-only
// @no-engine
type Accent = { kind: "colour"; value: string; on: string; gnome: "red" | "blue" } | { kind: "none" };
const palette = { 500: "#ff0000", 950: "#000000" };
const accent: Accent = { kind: "colour", value: palette[500], on: palette[950], gnome: "red" };
const empty: Accent = { kind: "none" };
function describe(value: Accent): void {
  console.log("kind", value.kind);
  if (value.kind === "colour") { console.log("colour", value.value, value.on, value.gnome); }
  else { console.log("none", value.kind); }
}
describe(accent);
describe(empty);
function choose(full: boolean): Accent {
  if (full) return { kind: "colour", value: "full", on: "text", gnome: "blue" };
  return { kind: "none" };
}
describe(choose(true));
describe(choose(false));
