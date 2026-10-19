// @rust-only
// @no-engine
function brokenDefault(): number { console.log("default throws"); throw "default"; }
async function broken(value: number = brokenDefault()): Promise<number> { return value; }
async function fail(flag: boolean): Promise<string> {
  try { console.log("try", flag); if (flag) throw "failure"; return "value"; }
  finally { console.log("finally", flag); }
}
async function replace(): Promise<number> { try { return 1; } finally { throw "replacement"; } }
async function recover(): Promise<number> { try { throw "ignored"; } finally { return 9; } }
try {
  broken().then(undefined, reason => { console.log("default rejected", reason as string); return 0; });
  fail(true).then(undefined, reason => { console.log("rejected", reason as string); return "handled"; });
  fail(false).then(value => { console.log("fulfilled", value); });
  replace().then(undefined, reason => { console.log("replaced", reason as string); return 0; });
  recover().then(value => { console.log("recovered", value); });
  console.log("calls returned");
} catch { console.log("wrong sync catch"); }
