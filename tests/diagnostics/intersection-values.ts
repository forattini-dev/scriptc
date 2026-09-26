// SC2008: intersection types that resolve to no runtime shape. Object-member
// intersections intern through the record path, literal-marker primitive
// brands erase to their primitive, and callable hybrids map to '%call'
// records. A primitive intersected with runtime-bearing data still fences.

// The producer has a BODY (an ambient `declare function` would compile to
// Node's ReferenceError at the call instead — the declare-erasure stance).
type RuntimeDecorated = number & { value: number };
function decorate(): RuntimeDecorated {
  return 1 as RuntimeDecorated;
}
console.log(decorate());
// Literal markers have no runtime slot after primitive-brand erasure. A use
// that tries to observe one retains a clean unsupported-site diagnostic.
type VisibleBrand = string & { readonly __brand: "VisibleBrand" };
const visible = "value" as VisibleBrand;
console.log(visible.__brand);
// The primitive representation never manufactures this field.
