import { SYMBOL_T, type IrType } from "./ir.js";

interface SingletonSymbol {
  rustVariant: string;
  argTypes: IrType[];
  result: IrType;
}

function singleton(rustVariant: string): SingletonSymbol {
  return { rustVariant, argTypes: [], result: SYMBOL_T };
}

/** Portable zero-argument singleton operations, independent of Symbol.for. */
export const WELL_KNOWN_SYMBOLS = {
  "sym.asyncIterator": singleton("AsyncIterator"),
  "sym.hasInstance": singleton("HasInstance"),
  "sym.isConcatSpreadable": singleton("IsConcatSpreadable"),
  "sym.iterator": singleton("Iterator"),
  "sym.match": singleton("Match"),
  "sym.matchAll": singleton("MatchAll"),
  "sym.replace": singleton("Replace"),
  "sym.search": singleton("Search"),
  "sym.species": singleton("Species"),
  "sym.split": singleton("Split"),
  "sym.toPrimitive": singleton("ToPrimitive"),
  "sym.toStringTag": singleton("ToStringTag"),
  "sym.unscopables": singleton("Unscopables"),
  "sym.dispose": singleton("Dispose"),
  "sym.asyncDispose": singleton("AsyncDispose"),
} as const;

export type WellKnownSymbolFn = keyof typeof WELL_KNOWN_SYMBOLS;

export function wellKnownSymbolVariant(operation: string): string | undefined {
  return Object.hasOwn(WELL_KNOWN_SYMBOLS, operation)
    ? WELL_KNOWN_SYMBOLS[operation as WellKnownSymbolFn].rustVariant : undefined;
}

export const WELL_KNOWN_SYMBOL_LIB_SIGS = WELL_KNOWN_SYMBOLS;
