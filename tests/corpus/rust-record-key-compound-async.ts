// @no-engine
const record: Record<string, number> = { count: 8 };
let trace = "";
async function key(): Promise<string> { trace += "K"; await Promise.resolve(); return "count"; }
async function rhs(): Promise<number> { trace += "V"; await Promise.resolve(); record["count"] = 50; return 3; }
const result = record[await key()] += await rhs();
console.log(trace, result, record["count"]);
