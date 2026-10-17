// @rust-only
// @no-engine
export {};
const NEED_LINE = Symbol('need line');
const OTHER_LINE = Symbol('need line');
const alias = NEED_LINE;
function choose(ready) { if (ready) return NEED_LINE; return OTHER_LINE; }
console.log('sentinel', alias === NEED_LINE, OTHER_LINE !== NEED_LINE, choose(true) === NEED_LINE, choose(false) === OTHER_LINE);
console.log('type', typeof NEED_LINE, typeof Symbol());
console.log('strings', NEED_LINE.toString(), Symbol().toString(), Symbol('').toString());
console.log('truthy', !NEED_LINE, !!Symbol());
