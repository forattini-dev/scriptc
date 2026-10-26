// @rust-only
// @no-engine
import {makePlan, calls} from "./lib/index.js";
function use(options) {
  const plan = makePlan(options);
  const alias = plan;
  console.log("plan", plan.width, plan.fit, plan.active, plan.nested.value);
  alias.width = 9;
  alias.nested.value = 11;
  console.log("alias", alias === plan, plan.width, plan.nested.value);
}
use({value: 3});
console.log("calls", calls());
