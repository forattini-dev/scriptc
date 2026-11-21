class Thing {
  count = 5;
  [Symbol.iterator](offset: number): number { return this.count + offset; }
}
export function create(): { value: Thing } { return { value: new Thing() }; }
