class Thing {
  count = 5;
  [Symbol.iterator](offset: number): number { return this.count + offset; }
}
export function create(): { value: Thing } { return { value: new Thing() }; }
export function createWithOptions(options: { name?: string }): { greeting: string } {
  return { greeting: options.name ?? 'fallback' };
}
const base: any = function (this: { value: number }): number { return this.value; };
export const boundFactory = base.bind({ value: 9 });
