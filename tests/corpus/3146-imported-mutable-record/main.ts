// @no-engine
import { state, bump, replace } from "./leaf.ts";
console.log("initial", state.nested.count, state.label);
bump();
console.log("call", state.nested.count, state.label);
const alias = state.nested;
alias.count = 7;
state.label = "changed";
console.log("alias", state.nested.count, state["nested"].count, state.nested["count"], state.label);
replace();
console.log("replace", state.nested.count, alias.count);
