// @no-engine
let events = '';
function part(label, number) {
  events += 'eval:' + label + ';';
  return { valueOf() { events += 'coerce:' + label + ';'; return number; } };
}
const date = new Date(part('year', 2024), part('month', 0), part('day', 2));
console.log(events, date.getFullYear(), date.getMonth(), date.getDate());
events = '';
try {
  new Date({ valueOf() { events += 'coerce;'; throw new Error('bad year'); } },
    part('month', 0), part('day', 1));
} catch (error) { console.log(String(error), events); }
const absent = undefined;
console.log(new Date(2024, 0, absent).getTime());
console.log(new Date('2024', false, true).getFullYear());
async function getMonth() { events += 'await;'; return 0; }
events = '';
const resumed = new Date(part('year', 2024), await getMonth(), part('day', 2));
console.log(events, resumed.getDate());
