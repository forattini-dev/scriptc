// @rust-only
// @no-engine
export {};
function convert(value: unknown): bigint { return BigInt(value as any); }
console.log("values", convert("9007199254740993") === 9007199254740993n, convert("0xff") === 255n, convert(4) === 4n, convert(true) === 1n, convert(false) === 0n, convert(7n) === 7n);
try { convert(undefined); } catch (error) { console.log("undefined", error instanceof TypeError, (error as Error).message); }
try { convert(null); } catch (error) { console.log("null", error instanceof TypeError, (error as Error).message); }
try { convert(Symbol("x")); } catch (error) { console.log("symbol", error instanceof TypeError, (error as Error).message); }
try { convert("bad"); } catch (error) { console.log("string", error instanceof SyntaxError, (error as Error).message); }
try { convert(1.5); } catch (error) { console.log("fraction", error instanceof RangeError, (error as Error).message); }
try { convert(1 / 0); } catch (error) { console.log("infinite", error instanceof RangeError, (error as Error).message); }
