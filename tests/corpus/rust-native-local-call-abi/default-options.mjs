// @rust-only
// @no-engine
function read(options = {}) { return options.width ?? 17; }
const handlers = {read(options = {}) { return options.width ?? 23; }};
const supplied = {width: 3};
console.log("function", String(read()), String(read(undefined)), String(read(supplied)));
console.log("method", String(handlers.read()), String(handlers.read(supplied)));
let previous;
function fresh(options = {}) { const same = options === previous; previous = options; return same; }
console.log("fresh", String(fresh()), String(fresh()), String(fresh(supplied)), String(fresh(supplied)));
try { read(null); } catch(error) { console.log("null", error instanceof TypeError); }
const viaArrow = (options = {}) => options.width ?? 29;
function chained(options = {}) { const alias = options; return alias; }
function guarded(options = {}) { return options && options.width; }
const returned = chained(supplied);
returned.width = 5;
console.log("aliases", returned === supplied, String(chained().width), String(viaArrow()), String(viaArrow(supplied)), String(guarded(supplied)), String(guarded(null)));
