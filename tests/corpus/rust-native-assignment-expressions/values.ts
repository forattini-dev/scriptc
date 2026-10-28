// @rust-only
// @no-engine
function run(): void {
  let first = 0;
  let second = 0;
  let calls = 0;
  const next = (): number => { calls = calls + 1; console.log("effect", calls); return 7; };
  const value = (first = second = next());
  console.log("chain", value, first, second, calls);
  const words = new Int32Array(1);
  console.log("conversion", first = second = (words[0] = 4294967297), first, second, words[0]);
  const increment = (): number => (first = first + 1);
  console.log("capture", increment(), first);
  const inner = (second = 4);
  console.log("result", inner, second);
}
run();
