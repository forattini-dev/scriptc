/**
 * The runtime census a compat-profile conformance suite reflects.
 *
 * The probes here are profile-agnostic: give them an interface name (and,
 * for anything that is not a global constructor, the profile's own factory
 * for reaching it) and they report the complete public surface the running
 * runtime exposes. A conformance suite compares that census against the
 * profile's declared inventory, so a Node upgrade that adds, moves, or
 * makes a member writable fails loudly instead of widening an unaudited
 * surface.
 */
import type { CompatInterfaceSource } from "@scriptc/compiler";

export interface InterfaceCensus {
  /** Own properties of the interface object, minus length/name/prototype. */
  statics: string[];
  /** Own properties of the prototype, minus constructor. */
  prototype: string[];
  /** Public properties reached further up the prototype chain. */
  inherited: string[];
  /** Public well-known symbol keys anywhere on the chain. */
  symbols: string[];
  /** Accessor properties on the chain that have a set function. */
  setters: string[];
  /** Own properties of a representative instance. */
  instance: string[];
}

const publicWellKnownSymbols = new Map<symbol, string>();
for (const name of Object.getOwnPropertyNames(Symbol)) {
  const value = (Symbol as unknown as Record<string, unknown>)[name];
  if (typeof value === "symbol") {
    publicWellKnownSymbols.set(value, `[Symbol.${name}]`);
  }
}

export function wellKnownSymbolNames(): ReadonlyMap<symbol, string> {
  return publicWellKnownSymbols;
}

/** Node-private transfer/inspection symbols are implementation details,
 * not the public surface a profile promises to classify. */
export function publicSymbolName(symbol: symbol): string | null {
  return publicWellKnownSymbols.get(symbol) ?? null;
}

/** Reflect one interface. `source` supplies the factories for interfaces
 * that are not globals of the same name — a constructor behind a module
 * export, or an iterator prototype with no constructor object at all. */
export function reflectInterface(
  name: string,
  source?: CompatInterfaceSource,
): InterfaceCensus {
  const explicitPrototype = source?.prototype?.();
  const ctor = explicitPrototype === undefined
    ? resolveConstructor(name, source)
    : null;
  const prototype = explicitPrototype !== undefined
    ? (explicitPrototype as object)
    : (ctor!.prototype as object);

  const own = Object.getOwnPropertyNames(prototype).filter(
    (member) => member !== "constructor",
  );
  const visibleNames = new Set(own);
  const inherited: string[] = [];
  const setters: string[] = [];
  const symbols: string[] = [];
  const visibleSymbols = new Set<symbol>();

  for (
    let current: object | null = prototype;
    current !== null && current !== Object.prototype;
    current = Object.getPrototypeOf(current) as object | null
  ) {
    for (const member of Object.getOwnPropertyNames(current)) {
      if (member === "constructor") continue;
      if (current !== prototype && !visibleNames.has(member)) {
        visibleNames.add(member);
        inherited.push(member);
      }
      const descriptor = Object.getOwnPropertyDescriptor(current, member);
      if (descriptor?.set !== undefined && !setters.includes(member)) {
        setters.push(member);
      }
    }
    for (const symbol of Object.getOwnPropertySymbols(current)) {
      if (visibleSymbols.has(symbol)) continue;
      visibleSymbols.add(symbol);
      const member = publicSymbolName(symbol);
      if (member !== null) symbols.push(member);
    }
  }

  return {
    statics: ctor === null
      ? []
      : Object.getOwnPropertyNames(ctor).filter(
          (member) => !["length", "name", "prototype"].includes(member),
        ),
    prototype: own,
    inherited,
    symbols,
    setters,
    instance: source?.instance === undefined
      ? []
      : Object.getOwnPropertyNames(source.instance() as object),
  };
}

function resolveConstructor(
  name: string,
  source?: CompatInterfaceSource,
): Function & { prototype: object } {
  const value = source?.resolve?.()
    ?? (globalThis as unknown as Record<string, unknown>)[name];
  if (typeof value !== "function") {
    throw new Error(`${name} must resolve to a constructor object`);
  }
  return value as Function & { prototype: object };
}
