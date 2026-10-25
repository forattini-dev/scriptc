// @rust-only
// @no-engine
try { console.log(BigInt("invalid")); } catch (error) { console.log("parse", error instanceof SyntaxError); }
try { console.log(BigInt(1.5)); } catch (error) { console.log("fraction", error instanceof RangeError); }
try { console.log(BigInt(1 / 0)); } catch (error) { console.log("infinity", error instanceof RangeError); }
try { console.log(1n / 0n); } catch (error) { console.log("division", error instanceof RangeError); }
try { console.log(1n % 0n); } catch (error) { console.log("remainder", error instanceof RangeError); }
try { console.log(2n ** -1n); } catch (error) { console.log("power", error instanceof RangeError); }
try { console.log(1n.toString(1)); } catch (error) { console.log("radix", error instanceof RangeError); }
let order = "";
function receiver(): bigint { order = order + "r"; return 15n; }
function argument(): number { order = order + "a"; return 16; }
function extra(): number { order = order + "e"; return 0; }
// @ts-ignore ignored ordinary arguments remain observable
console.log("order", receiver().toString(argument(), extra()), order);
function erased(value: any, radix: any): any { return value.toString(radix); }
try { erased(15n, Symbol("radix")); } catch (error) { console.log("symbol-radix", error instanceof TypeError); }
try { erased(15n, 16n); } catch (error) { console.log("bigint-radix", error instanceof TypeError); }
