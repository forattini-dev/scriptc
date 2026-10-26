let effects = 0;
function missing(): number { effects++; return 1; }
function select({value = missing(), ...rest}: any): string { return Object.keys(rest).join("|"); }
try { select(null); } catch (error) { console.log("null", error instanceof TypeError, effects); }
try { select(undefined); } catch (error) { console.log("undefined", error instanceof TypeError, effects); }
function fail(): number { throw new Error("stop"); }
function second(): number { effects++; return 2; }
function abrupt({first = fail(), next = second(), ...rest}: {first?: number; next?: number}): string { return Object.keys(rest).join("|"); }
try { abrupt({}); } catch (error) { console.log("abrupt", error instanceof Error, effects); }
function empty({}: any): string { return "empty"; }
try { empty(null); } catch (error) { console.log("empty", error instanceof TypeError); }
