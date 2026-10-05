// @ts-nocheck
class Base {
  value() { throw new Error("missing"); }
}
class NumberValue extends Base {
  value() { return 42; }
}
class Leaf extends NumberValue {
  value() { return super.value() + 1; }
}
class BooleanValue extends Base {
  value() { return false; }
}
class EmptyValue extends Base {
  value() { console.log("empty"); }
}
class MissingValue extends Base {
  value() { return super.value(); }
}
/** @param {Base} instance */
function printValue(instance) { console.log(instance.value()); }
printValue(new NumberValue());
printValue(new Leaf());
printValue(new BooleanValue());
printValue(new EmptyValue());
try { printValue(new MissingValue()); }
catch (error) { console.log(error.message); }
