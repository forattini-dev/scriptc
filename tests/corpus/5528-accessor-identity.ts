let value = 1;
let reads = 0;
const original = {
  get current() { reads++; return value; },
  set current(next: number) { value = next; },
};
const alias = original;
console.log('identity', alias === original, 'before', reads);
console.log('first', alias.current, 'reads', reads);
alias.current = 7;
console.log('after', original.current, 'reads', reads);
