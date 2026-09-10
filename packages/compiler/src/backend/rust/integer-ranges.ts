export type IntegerRange = { min: number; max: number };

export function integerLiteral(value: number): IntegerRange | null {
  return Number.isSafeInteger(value) && !Object.is(value, -0) ? { min: value, max: value } : null;
}

export function mergeIntegerRanges(a: IntegerRange, b: IntegerRange): IntegerRange {
  return { min: Math.min(a.min, b.min), max: Math.max(a.max, b.max) };
}

// Exact JS integers only. Multiplication must also preserve the sign of zero.
export function combineIntegerRanges(op: string, a: IntegerRange, b: IntegerRange): IntegerRange | null {
  let values: number[];
  if (op === "+") values = [a.min + b.min, a.max + b.max];
  else if (op === "-") values = [a.min - b.max, a.max - b.min];
  else if (op === "*") {
    if ((a.min <= 0 && a.max >= 0 && b.min < 0) || (b.min <= 0 && b.max >= 0 && a.min < 0)) return null;
    values = [a.min * b.min, a.min * b.max, a.max * b.min, a.max * b.max];
  } else return null;
  return values.every(Number.isSafeInteger) ? { min: Math.min(...values), max: Math.max(...values) } : null;
}
