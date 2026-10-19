import { read, write } from "./cycle-a.js";
function rhs() { console.log("cycle rhs"); return "early"; }
try { read(); } catch (error) { console.log("cycle read TDZ", error.message === "Cannot access 'cache' before initialization"); }
try { write(rhs()); } catch (error) { console.log("cycle write TDZ", error.message === "Cannot access 'cache' before initialization"); }
