// @rust-only
// @no-engine
function replacer(key: string, value: any): any {
  if (typeof value === "bigint") return value.toString();
  return value;
}
console.log("json", String(JSON.stringify({ value: 9007199254740993n }, replacer)));
console.log("root", String(JSON.stringify(12345678901234567890n, replacer)));
try { JSON.stringify(1n); } catch (error) { console.log("throws", error instanceof TypeError); }
try { JSON.stringify({ value: 1n }); } catch (error) { console.log("nested-throws", error instanceof TypeError); }
