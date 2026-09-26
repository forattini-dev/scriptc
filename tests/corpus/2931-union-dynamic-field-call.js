// A JS class union whose arms carry the same any-typed callable field:
// select the field by union tag, evaluate arguments once, and invoke the
// checked-dynamic function without requiring an engine.
class Left {
  constructor() {
    /** @type {*} */
    this.run = undefined;
    this.leftOnly = true;
  }
}

class Right {
  constructor() {
    /** @type {*} */
    this.run = undefined;
    this.rightOnly = true;
  }
}

/** @param {Left | Right} target @param {*} value */
function invoke(target, value) {
  return target.run(value);
}

const left = new Left();
left.run = () => "left";
const right = new Right();
right.run = () => "right";
let evaluations = 0;
function argument() {
  evaluations++;
  return 42;
}
console.log(invoke(left, argument()), evaluations);
console.log(invoke(right, argument()), evaluations);

left.run = () => "old-left";
right.run = () => "old-right";
function replaceBoth() {
  left.run = () => "new-left";
  right.run = () => "new-right";
  return 0;
}
/** @param {Left | Right} target */
function invokeWhileReplacing(target) {
  return target.run(replaceBoth());
}
console.log(invokeWhileReplacing(left), invoke(left, 0));
left.run = () => "old-left-2";
right.run = () => "old-right-2";
console.log(invokeWhileReplacing(right), invoke(right, 0));
