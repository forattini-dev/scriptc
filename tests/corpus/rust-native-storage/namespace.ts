// @rust-only
// @no-engine
import * as state from "./state.ts";
import { operations as live } from "./state.ts";

const named = state.getRevision;
state.replace();
console.log("namespace", state.revision, state.callback(), state.operations === live, named === state.getRevision);
