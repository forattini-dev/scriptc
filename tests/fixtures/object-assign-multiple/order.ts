const events: string[] = [];
const target: { a?: number; b?: number } = {};
const first = {
  get a(): number {
    events.push('get-a');
    return 1;
  },
};
function second(): { b: number } {
  events.push('second');
  return { b: 2 };
}
const result = Object.assign(target, first, second());
console.log(events.join(','), result === target, target.a, target.b);
