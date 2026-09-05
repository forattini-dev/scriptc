export interface Row {
  id: number;
  value: number;
  tags: string[];
}

export function makeRow(i: number): Row {
  return { id: i, value: (i * 7) % 101, tags: i % 2 === 0 ? ["even"] : ["odd", "x"] };
}

export function sumRows(rows: Row[]): number {
  let s = 0;
  for (const r of rows) s += r.value;
  return s;
}
