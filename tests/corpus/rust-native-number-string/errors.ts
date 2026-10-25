// @rust-only
// @no-engine
// @ts-nocheck
export {};
function invalid(radix: number) { try { (1).toString(radix); } catch (error) { console.log("range", error instanceof RangeError, String(error.message)); } }
invalid(0); invalid(1); invalid(37); invalid(-1); invalid(0 / 0); invalid(1 / 0);
try { (1).toString("bad"); } catch (error) { console.log("text", error instanceof RangeError, String(error.message)); }
try { (1).toString(null); } catch (error) { console.log("null", error instanceof RangeError); }
try { (1).toString(true); } catch (error) { console.log("boolean", error instanceof RangeError); }
console.log("after", (31).toString(undefined), (31).toString("16"));
