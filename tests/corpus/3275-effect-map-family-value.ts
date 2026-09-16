// @rust-only
// A closure FAMILY value handed to the effect kernel: `Effect.map(rows, transform)` where `transform` is the
// non-undefined arm of a generic slot. The kernel calls it later and has no call site to monomorphize against, so the
// slot's own concrete signature is the instantiation, and the family value is adapted to it.
import { Effect } from "effect";

type Transform = <A extends object>(rows: ReadonlyArray<A>) => ReadonlyArray<A>;

function identity<A extends object>(rows: ReadonlyArray<A>): ReadonlyArray<A> {
  return rows;
}

function dropFirst<A extends object>(rows: ReadonlyArray<A>): ReadonlyArray<A> {
  return rows.length === 0 ? rows : rows.slice(1);
}

// The Redcode shape: a connection method forwarding its optional transform to the effect.
function readNumbers(transform: Transform | undefined): Effect.Effect<ReadonlyArray<{ a: number }>> {
  const rows = Effect.succeed([{ a: 1 }, { a: 2 }, { a: 3 }] as ReadonlyArray<{ a: number }>);
  return transform ? Effect.map(rows, transform) : rows;
}

console.log(Effect.runSync(readNumbers(identity)).length);
console.log(Effect.runSync(readNumbers(dropFirst)).length);
console.log(Effect.runSync(readNumbers(undefined)).length);
console.log(JSON.stringify(Effect.runSync(readNumbers(dropFirst))));

// A SECOND instantiation of the same family through the same kernel slot: a different row shape demands its own body.
function readNames(transform: Transform | undefined): Effect.Effect<ReadonlyArray<{ name: string }>> {
  const rows = Effect.succeed([{ name: "ada" }, { name: "grace" }] as ReadonlyArray<{ name: string }>);
  return transform ? Effect.map(rows, transform) : rows;
}

console.log(Effect.runSync(readNames(identity)).map((r) => r.name).join(","));
console.log(Effect.runSync(readNames(dropFirst)).map((r) => r.name).join(","));
console.log(Effect.runSync(readNames(undefined)).length);

// Both instantiations again, interleaved: each adapted value keeps its own implementation.
const ns = Effect.runSync(readNumbers(dropFirst));
const names = Effect.runSync(readNames(identity));
console.log(ns.length, names.length, ns[0]?.a, names[0]?.name);

// The family value also still works where a real call site monomorphizes it.
function directly(transform: Transform, rows: ReadonlyArray<{ a: number }>): number {
  return transform(rows).length;
}
console.log(directly(identity, [{ a: 1 }, { a: 2 }]), directly(dropFirst, [{ a: 1 }, { a: 2 }]));
