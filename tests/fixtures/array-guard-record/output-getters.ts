type Result = { status?: string[] };
function display(result: Result) {
  return result.status
    ? [{ key: 'Status', value: Array.isArray(result.status) ? result.status.join(', ') : result.status }]
    : [];
}
let reads = 0;
let live: any = ['a', 'b'];
const raw: any = { get status() { reads++; return live; } };
const view = raw as Result;
console.log('array', JSON.stringify(display(view)), reads);
live = 'ready';
console.log('string', JSON.stringify(display(view)), reads);
live = { n: 3 };
console.log('object', JSON.stringify(display(view)), reads);
live = null;
console.log('null', JSON.stringify(display(view)), reads);
