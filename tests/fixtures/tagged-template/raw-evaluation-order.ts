const values = [1];
const events: string[] = [];
function change(): string {
  events.push('change');
  values[0] = 2;
  return '!';
}
console.log(String.raw`${values}${change()}`, events.join(','));
