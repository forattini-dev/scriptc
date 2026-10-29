import { check, unsafe } from "./impl.mjs";
console.log("check", check(undefined), check(null), check(""), check("-x"), check("x"));
let effects = 0;
function extra(): string { effects++; return "-"; }
try { unsafe(undefined, extra); }
catch (error) { console.log("error", error instanceof TypeError, effects); }
try { unsafe(null, extra); }
catch (error) { console.log("null", error instanceof TypeError, effects); }
console.log("present", unsafe("-x", extra), effects);
