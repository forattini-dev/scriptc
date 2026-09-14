// @rust-only
// Optional chains over SUB-unions: `?.` on `A | B | undefined` guards the
// whole receiver union, and the guarded read switches over the record and
// class arms. Also covers reads narrowed by `!== undefined`/`!= null`,
// tails, receiver evaluation order, and mutation through shared identity.
type Rec = { kind: "rec"; name: string; size: number };
type Other = { kind: "other"; name: string; flag: boolean };

class Named {
  kind = "named" as const;
  name: string;
  size: number;
  constructor(name: string, size: number) {
    this.name = name;
    this.size = size;
  }
}

let calls = 0;
function pick(i: number): Rec | Named | undefined {
  calls++;
  if (i === 0) return { kind: "rec", name: "record", size: 2 };
  if (i === 1) return new Named("class", 5);
  return undefined;
}

function pickNull(i: number): Rec | Other | null {
  if (i === 0) return { kind: "rec", name: "", size: 0 };
  if (i === 1) return { kind: "other", name: "other", flag: false };
  return null;
}

for (let i = 0; i < 3; i++) {
  const item = pick(i);
  console.log(item?.name, item?.kind, item?.size, item?.name.length, item?.name.toUpperCase());
  if (item !== undefined) console.log("narrowed", item.name, item.size + 1);
  const other = pickNull(i);
  console.log(other?.name, other?.kind, other?.name.length === 0);
  if (other != null) console.log("loose", other.kind);
}

// The receiver evaluates once, and a nullish receiver skips the tail.
calls = 0;
console.log(pick(1)?.name, pick(2)?.name.length, calls);

// Shared identity: a write through the class arm is visible to the chain.
const shared = new Named("before", 1);
const view: Rec | Named | undefined = shared;
shared.name = "after";
console.log(view?.name, view?.size);

const labels = [0, 1, 2].map((i) => pick(i)?.name ?? "none");
console.log(labels.join(","));
