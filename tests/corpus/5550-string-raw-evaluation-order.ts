const values = [1];
const events: string[] = [];
function change(): string {
  events.push('change');
  values[0] = 2;
  return '!';
}
console.log(String.raw`raw\n${values}${change()}`, events.join(','));
values[0] = 1;
events.length = 0;
console.log(`ordinary\n${values}${change()}`, events.join(','));
