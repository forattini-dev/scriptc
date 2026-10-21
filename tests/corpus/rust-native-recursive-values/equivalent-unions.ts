// @rust-only
// @no-engine
interface ItemA { kind: "item"; item?: ItemA; value: number; }
interface ItemB { kind: "item"; value: number; item?: ItemB; }
interface NamedA { kind: "named"; child?: NamedA; name: string; }
interface NamedB { kind: "named"; name: string; child?: NamedB; }
type Target = ItemA | NamedA;
type Source = NamedB | ItemB;
function project(value: Target): Target { return value; }
function check(value: Source): void {
  const alias: Target = project(value);
  console.log(alias === value);
  if (alias.kind === "item") {
    console.log(alias.value);
    if (alias.item !== undefined) console.log(alias.item === alias);
    alias.value = 21;
  } else {
    console.log(alias.name);
    if (alias.child !== undefined) console.log(alias.child === alias);
    alias.name = "changed";
  }
}
const item: ItemB = { kind: "item", value: 2 };
item.item = item;
const named: NamedB = { kind: "named", name: "named" };
named.child = named;
check(item);
check(named);
console.log(item.value, named.name);
