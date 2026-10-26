// @ts-nocheck
// @rust-only
// @no-engine
export {};
var state: {value: number} | undefined | null = {value: 1};
function read(): number { return state!.value; }
function write(value: number): void { state!.value = value; }
function clearUndefined(): void { state = undefined; }
function clearNull(): void { state = null; }
write(7);
console.log("record", read());
clearUndefined();
try { read(); } catch (error) { console.log("read-undefined", error instanceof TypeError, String(error.message)); }
try { write(2); } catch (error) { console.log("write-undefined", error instanceof TypeError, String(error.message)); }
clearNull();
try { read(); } catch (error) { console.log("read-null", error instanceof TypeError, String(error.message)); }
try { write(2); } catch (error) { console.log("write-null", error instanceof TypeError, String(error.message)); }
