// @rust-only
// @no-engine
import { Buffer } from "node:buffer";
import { readSync } from "node:fs";
function report(label: string, error: unknown): void { const e = error as any; console.log("error", label, String(e.name), String(e.code), String(e.message)); }
function invalid(size: number): void {
    try { Buffer.alloc(size); } catch (error) { report("alloc", error); }
    try { Buffer.allocUnsafe(size); } catch (error) { report("unsafe", error); }
}
invalid(-1); invalid(-0.5); invalid(0 / 0); invalid(1 / 0); invalid(9007199254740992); invalid(1e21);
try { readSync(123456, Buffer.alloc(0), 0, 1, -99); } catch (error) { report("empty buffer", error); }
try { readSync(123456, new Uint8Array(0), 0, 1, -99); } catch (error) { report("empty typed", error); }
console.log("zero", readSync(123456, Buffer.allocUnsafe(0), 99, 0, -99));
let effects = "";
function size(): number { effects = effects + "s"; throw new Error("size exploded"); }
try { Buffer.allocUnsafe(size()); } catch (error) { report("argument", error); }
console.log("effects", effects);
