// @rust-only
// @no-engine
// @ts-nocheck
let current: number[] | null | undefined = [1];
let calls = 0;
function receiver(): number[] | null | undefined { calls++; return current; }
console.log('present', receiver().length, calls);
current = null;
try { console.log(receiver().length); } catch (e) { if (e instanceof Error) console.log('null', e.name, e.message, calls); else throw e; }
current = undefined;
try { console.log(receiver()['length']); } catch (e) { if (e instanceof Error) console.log('undefined', e.name, e.message, calls); else throw e; }
let keys = 0;
function index(): number { keys++; return 0; }
try { console.log(receiver()[index()]); } catch (e) { if (e instanceof Error) console.log('index', e.message, calls, keys); else throw e; }
function failIndex(): number { keys++; throw new Error('key failed'); }
try { console.log(receiver()[failIndex()]); } catch (e) { if (e instanceof Error) console.log('abrupt', e.message, calls, keys); else throw e; }
