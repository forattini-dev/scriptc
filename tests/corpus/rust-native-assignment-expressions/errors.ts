// @rust-only
// @no-engine
function run(): void {
  let first = 1;
  let second = 2;
  const fail = (): number => { console.log("effect"); throw new Error("boom"); };
  try { first = second = fail(); }
  catch (error) { if (error instanceof Error) console.log("caught", error.message); }
  console.log("after", first, second);
}
run();
