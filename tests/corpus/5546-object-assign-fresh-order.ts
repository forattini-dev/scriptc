const events: string[] = [];
const first = {
  get value(): number {
    events.push('get');
    return 1;
  },
};
function second(): { later: number } {
  events.push('argument');
  return { later: 2 };
}
const result = Object.assign({}, first, second());
console.log(events.join(','), result.value, result.later);
