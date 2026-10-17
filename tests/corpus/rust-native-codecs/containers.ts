// @rust-only
// @no-engine
const encoder = new TextEncoder();
const decoder = new TextDecoder();
const values: Uint8Array[] = [encoder.encode("one"), encoder.encode("two")];
function decodeStored(items: Uint8Array[]): string { return decoder.decode(items[1]); }
console.log("containers", decodeStored(values));
const table = new Map<string, Uint8Array>();
table.set("payload", values[0]);
const found = table.get("payload");
if (found !== undefined) { console.log("containers", found === values[0], decoder.decode(found)); }
const optional: Uint8Array | undefined = values[1];
if (optional !== undefined) { console.log("containers", decoder.decode(optional)); }
try { new Uint8Array(-1); } catch (error) { if (error instanceof RangeError) { console.log("containers", "negative length"); } }
try { values[0].set(encoder.encode("oversized")); } catch (error) { if (error instanceof RangeError) { console.log("containers", "set bounds"); } }
