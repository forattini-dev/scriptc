const events: string[] = [];
const target: any = {};
Object.defineProperty(target, 'value', {
  set(value: number) { events.push('set:' + value); },
});
const source = {
  get value(): number { events.push('get'); return 7; },
};
function later(): { other: number } { events.push('later'); return { other: 8 }; }
const result = Object.assign(target, source, later());
console.log(events.join(','), result === target, target.other);
