// @rust-only
// @no-engine
const SIGNAL_NAMES: Record<number, string> = { 2: "SIGINT", 9: "SIGKILL", 15: "SIGTERM" };
function label(signo: number): string { return String(SIGNAL_NAMES[signo]); }
console.log("signals", label(2), label(9), label(15), label(99));
function read(map: Record<number, string>, key: number): string | undefined { return map[key]; }
console.log("missing", read(SIGNAL_NAMES, 99) === undefined);
const values: Record<number, string> = { 0: "zero", 1.5: "fraction", 1e21: "large", 1e-7: "small" };
function check(key: number): void { console.log("key", String(key), String(read(values, key))); }
check(-0); check(0); check(1.5); check(1e21); check(1e-7); check(0 / 0); check(1 / 0); check(-(1 / 0));
function write(key: number, value: string): void { values[key] = value; }
write(-0, "changed"); write(0 / 0, "nan"); write(1 / 0, "infinity"); write(-2, "negative");
console.log("writes", String(values[0]), String(values["NaN"]), String(values["Infinity"]), String(values[-2]));
const asStrings: Record<string, string> = values;
console.log("same property", String(asStrings["0"]), String(asStrings["1.5"]), String(asStrings["01"]), asStrings === values);
let effects = "";
function receiver(): Record<number, string> { effects = effects + "r"; return values; }
function key(): number { effects = effects + "k"; return 7; }
function data(): string { effects = effects + "v"; return "seven"; }
receiver()[key()] = data();
console.log("write order", effects, String(values[7]));
effects = "";
console.log("read order", String(receiver()[key()]), effects);

const numbers: Record<number, number> = { 0: -0, 1: 0 / 0, 2: 1 / 0 };
console.log("optional numbers", numbers[0], numbers[1], numbers[2], numbers[99]);
const flags: Record<number, boolean> = { 1: false, 2: true };
console.log("optional booleans", flags[1], flags[2], flags[3]);
const absent = SIGNAL_NAMES[99];
console.log("inferred", absent, absent === undefined);
