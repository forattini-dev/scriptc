// Class instances cross `unknown` as identity-preserving typed-reference
// capsules. Exact checked extraction returns the original object; generic
// dyn consumers materialize the class's enumerable own fields lazily.
class Box {
  name: string;
  count: number;
  child: Box | undefined = undefined;
  #secret: string;
  private tsPrivate: string;

  constructor(name: string, count: number) {
    this.name = name;
    this.count = count;
    this.#secret = `secret:${name}`;
    this.tsPrivate = `ts-private:${name}`;
  }

  bump(): void {
    this.count++;
  }

  privateState(): string {
    return `${this.#secret}|${this.tsPrivate}`;
  }
}

function throughUnknown(value: unknown): unknown {
  return value;
}

const leaf = new Box("leaf", 2);
const root = new Box("root", 1);
root.child = leaf;

const opaque = throughUnknown(root);
const recovered = opaque as Box;
console.log("same root:", recovered === root);
recovered.bump();
console.log("mutated:", root.count);
console.log("private:", recovered.privateState());
console.log("materialized:", JSON.stringify(opaque));

const table: Record<string, unknown> = {};
table["root"] = root;
const fromTable = table["root"] as Box;
console.log("same table:", fromTable === root, fromTable.child === leaf);

function optional(value: Box | undefined): unknown {
  return value;
}

const optionalBox = optional(leaf) as Box | undefined;
const optionalMissing = optional(undefined);
console.log("optional:", optionalBox === leaf, optionalMissing === undefined);

// A boxed closure's result crosses through the same typed-reference capsule. Use a wider return signature so the dynamic call thunk runs instead of the exact-signature fast path simply unboxing the closure.
const opaqueFactory: unknown = (name: string): Box => new Box(name, 3);
const invokeFactory = opaqueFactory as (name: string) => unknown;
const made = invokeFactory("made") as Box;
console.log("factory:", made.name, made.count);
