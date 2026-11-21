// @rust-only
// @no-engine
async function fail(): Promise<number> { throw "rejected"; }
function throwsBeforePromise(): Promise<number> { throw "synchronous"; }
async function resolved(): Promise<number> { try { return await Promise.resolve(3); } catch { return 9; } }
async function rejected(): Promise<number> { try { return await fail(); } catch { return 9; } }
async function thrown(): Promise<number> { try { return await throwsBeforePromise(); } catch { return 8; } }
async function two(): Promise<number> { try { const value = await Promise.resolve(4); return await Promise.resolve(value); } catch { return 7; } }
async function twoRejected(): Promise<number> { try { const value = await fail(); return await Promise.resolve(value); } catch { return 6; } }
async function firstThrown(): Promise<number> { try { const value = await throwsBeforePromise(); return await Promise.resolve(value); } catch { return 12; } }
async function secondFail(value: number): Promise<number> { throw value; }
function secondThrow(value: number): Promise<number> { throw value; }
async function rejectedSecond(): Promise<number> { try { const value = await Promise.resolve(5); return await secondFail(value); } catch { return 10; } }
async function thrownSecond(): Promise<number> { try { const value = await Promise.resolve(5); return await secondThrow(value); } catch { return 11; } }
async function add(value: number, offset: number): Promise<number> { return value + offset; }
async function addRecord(value: number, state: { value: number }): Promise<number> { return value + state.value; }
async function captureScalar(offset: number): Promise<number> { try { const value = await Promise.resolve(3); return await add(value, offset); } catch { return 13; } }
async function captureRecord(state: { value: number }): Promise<number> { try { const value = await Promise.resolve(3); return await addRecord(value, state); } catch { return 14; } }
async function captureRejected(state: { value: number }): Promise<number> { try { const value = await fail(); return await addRecord(value, state); } catch { return 15; } }
function transientRecord(): Promise<number> { const temporary = { value: 8 }; return captureRecord(temporary); }
function transientRejected(): Promise<number> { const temporary = { value: 8 }; return captureRejected(temporary); }
resolved().then((value) => console.log("resolved", value));
rejected().then((value) => console.log("rejected", value));
thrown().then((value) => console.log("thrown", value));
two().then((value) => console.log("two", value));
twoRejected().then((value) => console.log("two rejected", value));
firstThrown().then((value) => console.log("first thrown", value));
rejectedSecond().then((value) => console.log("second rejected", value));
thrownSecond().then((value) => console.log("second thrown", value));
captureScalar(7).then((value) => console.log("captured scalar", value));
const state = { value: 1 };
const captured = captureRecord(state);
state.value = 9;
captured.then((value) => console.log("captured record", value));
transientRecord().then((value) => console.log("transient", value));
transientRejected().then((value) => console.log("transient rejected", value));
console.log("sync");
