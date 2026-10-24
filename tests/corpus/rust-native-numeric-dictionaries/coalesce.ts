// @rust-only
// @no-engine
const signals: Record<number, string> = { 2: "SIGINT", 9: "SIGKILL", 15: "SIGTERM" };
function signal(signo: number): string | null { return signals[signo] ?? null; }
console.log("signal", signal(2), signal(9), signal(99));
let trace = "";
function fallback(): string { trace = trace + "f"; return "fallback"; }
function left(value: unknown): unknown { trace = trace + "l"; return value; }
function check(value: unknown): void { trace = ""; console.log("nullish", String(left(value) ?? fallback()), trace); }
check(undefined); check(null); check(0); check(-0); check(false); check(""); check("kept"); check(0 / 0);
const values: Record<number, number> = { 0: 0, 1: -0 };
function number(key: number): number { return values[key] ?? 99; }
console.log("numbers", number(0), number(1), number(2));
function fail(): string { throw new Error("rhs"); }
console.log("lazy", String(signals[2] ?? fail()));
try { signals[99] ?? fail(); } catch (error) { if (error instanceof Error) console.log("throw", error.message); else throw error; }
