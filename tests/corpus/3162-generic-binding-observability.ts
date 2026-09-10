// @rust-only
// @no-engine
type Identity = <T>(value: T) => T;

let discarded: Identity;
discarded = <T>(value: T): T => value;

// The target is never read, but this assignment's value escapes.
let target: Identity;
const retained = (target = <T>(value: T): T => value);
console.log(retained(7), retained("kept"));

// An unread function value can still have observable creation effects.
let effects = 0;
function makeIdentity(): Identity {
  effects += 1;
  return <T>(value: T): T => value;
}
const unused = makeIdentity();
let overwritten: Identity;
overwritten = makeIdentity();
console.log(effects);

const called: Identity = <T>(value: T): T => value;
console.log(called(11), called("called"));
