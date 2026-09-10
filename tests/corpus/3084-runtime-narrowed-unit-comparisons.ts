// @no-engine
interface State { value: string[] | undefined | null }
const state: State = { value: undefined };
function clear(value: State): void { value.value = undefined; }
function nil(value: State): void { value.value = null; }
state.value = ["set"];
clear(state);
console.log("undefined", state.value === undefined, undefined === state.value, state.value !== undefined);
console.log("nullish", state.value == null, state.value != null, typeof state.value, typeof state.value === "undefined");
state.value = ["again"];
nil(state);
console.log("null", state.value === null, null !== state.value, state.value == null, typeof state.value);
function fill(value: State): void { value.value = ["filled"]; }
state.value = undefined;
fill(state);
console.log("filled", state.value === undefined, state.value == null, typeof state.value);
nil(state);
let reads = 0;
function read(): State { reads++; return state; }
console.log("receiver", read().value === null, reads);
function throwing(): State { throw new Error("receiver"); }
try { console.log(throwing().value === undefined); } catch (error) {
  if (error instanceof Error) console.log("throw", error.message);
}
export {};
