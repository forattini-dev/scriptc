class Rows {
  *[Symbol.iterator](): Generator<{ cells: number[] }, void, undefined> {
    yield { cells: [1, 2] };
    yield { cells: [3] };
  }
}

function erase(value: any): any {
  return value;
}

const rows: any = erase(new Rows());
console.log(Symbol.iterator in rows, typeof rows[Symbol.iterator]);
