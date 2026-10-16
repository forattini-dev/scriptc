// @rust-only
// @no-engine
class Fault extends Error {
  code: number;
  constructor(message: string, code = 7) {
    super(message);
    this.code = code;
    this.name = "Fault";
  }
}
const Alias = Fault;
const second = Alias;
const fault = new second("aliased");
console.log("alias", fault.message, fault.code, fault instanceof Alias, Alias === Fault);
function make(ctor: typeof Fault, message: string): Fault {
  return new ctor(message, 9);
}
const made = make(Alias, "parameter");
console.log("parameter", made.message, made.code, made instanceof Fault);
const Constructor = class extends Error {
  constructor(message: string) {
    super(message);
    this.name = "Expression";
  }
};
const copy = Constructor;
const expression = new copy("expression");
console.log("expression", expression.name, expression.message, expression instanceof Constructor, copy === Constructor);
var Hoisted = class extends Error {};
const hoisted = new Hoisted("hoisted");
console.log("hoisted", hoisted.message, hoisted instanceof Hoisted);
console.log("before var", HoistedAlias === undefined);
var HoistedAlias: typeof Fault | undefined = Fault;
if (HoistedAlias !== undefined) {
  const guarded = new HoistedAlias("guarded");
  console.log("guarded", guarded.message, guarded.code);
}
function choose(): typeof Fault {
  console.log("constructor expression");
  return Alias;
}
function argument(): string {
  console.log("argument");
  return "ordered";
}
const ordered = new (choose())(argument());
console.log("ordered", ordered.message, ordered.code);
const constructors: (typeof Fault)[] = [Alias, second];
const holder = { ctor: constructors[0] };
const stored = new holder.ctor("stored", 12);
console.log("containers", stored.message, stored.code, holder.ctor === Fault);
function captured(ctor: typeof Fault): () => Fault {
  return () => new ctor("captured");
}
console.log("capture", captured(Alias)().code);
const baseAlias = Fault;
const Derived = class extends baseAlias {};
const derived = new Derived("inherited", 18);
console.log("derived", derived.message, derived.code, derived instanceof Fault, derived instanceof baseAlias);
