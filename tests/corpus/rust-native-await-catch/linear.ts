// @rust-only
// @no-engine
async function text(): Promise<string> { return "  RED-SKILLS  "; }
async function rejected(): Promise<number> { throw "failure"; }
function thrown(): Promise<number> { throw "sync"; }
function failReturn(value: number): boolean { throw value; }
async function complete(): Promise<boolean> {
  try {
    const state = { marker: 4 };
    const value = (await text()).trim();
    await Promise.resolve(state.marker);
    await Promise.resolve(1);
    return value.toLowerCase().includes("red-skills");
  } catch { return false; }
}
async function failFirst(): Promise<boolean> {
  try {
    const state = { marker: 4 };
    const first = await rejected();
    await Promise.resolve(state.marker);
    return first > 0;
  } catch { return false; }
}
async function failSecond(): Promise<boolean> {
  try {
    const state = { marker: 4 };
    const first = await Promise.resolve(state.marker);
    await rejected();
    return first > 0;
  } catch { return false; }
}
async function throwSecond(): Promise<boolean> {
  try {
    const first = await Promise.resolve(4);
    await thrown();
    return first > 0;
  } catch { return false; }
}
async function throwAfter(): Promise<boolean> {
  try {
    const first = await Promise.resolve(4);
    await Promise.resolve(5);
    return failReturn(first);
  } catch { return false; }
}
complete().then((v) => console.log("complete", v));
failFirst().then((v) => console.log("first", v));
failSecond().then((v) => console.log("second", v));
throwSecond().then((v) => console.log("throw", v));
throwAfter().then((v) => console.log("after", v));
console.log("sync");
