// @rust-only
// @no-engine
import {makePlan, calls} from "./lib/index.js";
function exercise(value) {
  console.log("before", String(value), calls());
  const plan = makePlan({value});
  const alias = plan;
  const read = () => plan.width;
  console.log("captured", String(read()), calls());
  alias.width = 13;
  alias.nested.value = 17;
  console.log("after", String(read()), String(plan.nested.value), calls());
  return read();
}
console.log("result", String(exercise(4)), calls());
