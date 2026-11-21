type Sorter = (left: unknown, right: unknown) => number;

function normalize(sorter: boolean | Sorter | undefined): Sorter | null | undefined {
  return typeof sorter === "function"
    ? sorter
    : sorter === true
      ? () => 1
      : null;
}

console.log(typeof normalize(true));

function projected(value: boolean | Sorter | undefined): Sorter | null | undefined {
  return value as Sorter | null | undefined;
}
console.log(typeof projected(() => 2));
