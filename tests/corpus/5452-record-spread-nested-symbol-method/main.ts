class IterableField {
  readonly value: number;

  constructor(value: number) {
    this.value = value;
  }

  [Symbol.iterator](): Iterator<number> {
    return [this.value][Symbol.iterator]();
  }

  touch(): number {
    return this.value;
  }
}

interface Source {
  name: string;
  owner: IterableField | null;
}

const owner = new IterableField(7);
console.log(owner.touch());
const source: Source = { name: "present", owner };
const second: Source = { ...source, name: "second" };
console.log(
  second.name,
  second.owner === owner,
  Object.keys(second).join(","),
);
