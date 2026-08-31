// The class-values fences: everything outside the honest v1 boundary is a
// NAMED fence — never wrong dispatch, never silently-wrong storage.
class Base {
  constructor(n: number) {}
  static tag = "base";
}
class Derived extends Base {
  // A DIFFERENT constructor ABI than Base's.
  constructor() {
    super(1);
  }
}
class Shadowing extends Base {
  static tag = "shadowed";
}
class Unrelated {
  constructor(n: number) {}
  static tag = "unrelated";
}

// Builtin classes as values: their construction is libCall-shaped.
const E = Error;

// Error subclasses now have ordinary class-value construct thunks: their
// emitted constructor owns the error.ctor bridge used by super().
class MyErr extends Error {}
const M = MyErr;

// Structural class-value flows between unrelated classes: nominal identity
// is the IR's only class subtyping.
const structural: typeof Base = Unrelated;

// Widening whose constructor ABIs differ: construction through the slot
// would dispatch a mismatched signature.
const widened: typeof Base = Derived;

// Writing an inherited static through a SUBCLASS name creates an own
// property in JS — different storage.
class PlainSub extends Base {}
PlainSub.tag = "write";

// Writing statics through a general class VALUE: the runtime class decides.
let someClass: typeof Base = Base;
someClass.tag = "write";

// Reading a static a subclass REDECLARES through a class value: the
// runtime class decides which declaration answers.
console.log(someClass.tag);

// Class expressions inside functions mint a DISTINCT class per evaluation.
function make(): unknown {
  return class {};
}
make();

// Statics-bearing class expressions outside a whole-initializer position:
// their declaration-time code must run exactly where the expression
// evaluates.
const pair = [1, class WithStatic { static x = 1; }] as const;

// Construction through a UNION of class values: narrow or annotate first.
class Left {
  constructor() {}
}
class Right {
  constructor() {}
}
let pick: typeof Left | typeof Right = Left;
const picked = new pick();
void picked;

// `this` in a static method names the RECEIVER class — a dynamic value.
class UsesThis {
  static self(): string {
    return this.name;
  }
}
console.log(UsesThis.self());
