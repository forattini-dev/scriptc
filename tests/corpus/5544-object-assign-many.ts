const events: string[] = [];
const target: { a?: number; b?: number; c?: number } = {};
const first = {
  get a(): number {
    events.push('get-a');
    return 1;
  },
};
function second(): { b: number; a: number } {
  events.push('second');
  return { b: 2, a: 3 };
}
function third(): { c: number } {
  events.push('third');
  return { c: 4 };
}
const result = Object.assign(target, first, second(), null, undefined, third());
console.log(events.join(','), result === target, target.a, target.b, target.c);
