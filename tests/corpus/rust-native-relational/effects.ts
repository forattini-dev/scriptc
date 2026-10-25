// @rust-only
// @no-engine
// @ts-nocheck
let trace = '';
function left(value: unknown): unknown { trace = trace + 'L'; return value; }
function right(value: unknown): unknown { trace = trace + 'R'; return value; }
console.log('order', left('2') < right(10), trace);
const symbol = Symbol('relational');
trace = '';
try { console.log(left(symbol) < right(1)); } catch (e) { if (e instanceof Error) console.log('caught', e.name, e.message, trace); else throw e; }
trace = '';
try { console.log(left(symbol) <= right(1)); } catch (e) { if (e instanceof Error) console.log('caught', e.name, e.message, trace); else throw e; }
trace = '';
try { console.log(left(symbol) > right(1)); } catch (e) { if (e instanceof Error) console.log('caught', e.name, e.message, trace); else throw e; }
trace = '';
try { console.log(left(symbol) >= right(1)); } catch (e) { if (e instanceof Error) console.log('caught', e.name, e.message, trace); else throw e; }
trace = '';
try { console.log(left(undefined) < right(symbol)); } catch (e) { if (e instanceof Error) console.log('caught', e.name, e.message, trace); else throw e; }
function fail(): unknown { trace = trace + 'F'; throw new Error('rhs'); }
trace = '';
try { console.log(left(symbol) < fail()); } catch (e) { if (e instanceof Error) console.log('caught', e.name, e.message, trace); else throw e; }
trace = '';
try { console.log(fail() < right(2)); } catch (e) { if (e instanceof Error) console.log('caught', e.name, e.message, trace); else throw e; }
