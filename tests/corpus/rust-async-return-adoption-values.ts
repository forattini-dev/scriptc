// @rust-only
// @no-engine
// Adoption preserves values and identity across the native Rust promise ABI.
interface Point { x: number; y: number }
const log: string[] = [];
const shared: Point = { x: 4, y: 8 };
const sharedList: number[] = [1, 2, 3];
async function point(): Promise<Point> { return shared; }
async function list(): Promise<number[]> { return sharedList; }
async function text(): Promise<string> { return "text"; }
async function quiet(): Promise<void> { log.push("quiet"); }
async function fail(): Promise<Point> { throw new Error("rejected"); }
async function discard(): Promise<void> { return quiet(); }
async function relay(): Promise<Point> {
  try { return point(); } finally { log.push("finally"); }
}
const concise = async (): Promise<Point> => point();
const conciseVoid = async (): Promise<void> => quiet();
async function narrowed(): Promise<{ x: number }> { return point(); }
const conciseNarrowed = async (): Promise<{ x: number }> => point();
async function widened(): Promise<Point | string> { return point(); }
class Holder { async get(): Promise<Point> { return point(); } }
async function run(): Promise<void> {
  console.log(await relay() === shared, await concise() === shared, await new Holder().get() === shared);
  console.log(await list() === sharedList, await text());
  await discard();
  await conciseVoid();
  const paired = await point().then(p => point(), e => point());
  const pairedList = await list().then(xs => list(), e => list());
  const recovered = await fail().then(p => point(), e => point());
  console.log(paired === shared, pairedList === sharedList, recovered === shared);
  const chained = await point().then(p => point());
  console.log(chained === shared);
  console.log((await narrowed()).x, (await conciseNarrowed()).x);
  const wide = await widened();
  if (typeof wide !== "string") console.log(wide === shared);
  let ticks = Promise.resolve();
  for (let i = 0; i < 8; i++) { const k = i; ticks = ticks.then(() => { log.push(`t${k}`); }); }
  const adoption = point().then(p => point()).then(p => { log.push(`done${p.x}`); });
  queueMicrotask(() => { log.push("q"); });
  await ticks;
  await adoption;
  console.log(log.join(" "));
}
run();
