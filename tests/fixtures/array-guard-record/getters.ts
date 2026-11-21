type Result = { status?: string[] };
function display(result: Result) {
  return result.status ? JSON.stringify(Array.isArray(result.status) ? result.status.join(', ') : result.status) : 'none';
}
let reads = 0;
let live: any = ['a', 'b'];
const raw: any = { get status() { reads++; return live; } };
const view = raw as Result;
console.log('array', display(view), reads);
live = 'ready';
console.log('string', display(view), reads);
live = null;
console.log('null', display(view), reads);
