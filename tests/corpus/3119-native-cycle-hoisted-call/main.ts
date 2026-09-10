// Calls across the cycle during initialization use only hoisted functions and
// their parameters. Pin the accepted counterpart of cycle-window-call's TDZ.
import { aye } from "./a.ts";
console.log(aye(5));
