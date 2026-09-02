// The bridge adopts a package promise LAZILY, so the engine timer that
// settles it competes with the static timer on the SHARED heap and loses.
// A blocking adoption would instead drain the engine timer at the call
// site — before the loop ever starts — and print "island: 40" first.
import { later } from "promisezoo";

async function run(): Promise<void> {
  const value: number = await later(20, 20);
  console.log("island: " + String(value));
}
setTimeout(() => {
  console.log("static tick");
}, 0);
run();
console.log("main done");
