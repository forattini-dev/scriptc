type Result = { status?: string[] };
function display(result: Result) {
  return result.status ? JSON.stringify(Array.isArray(result.status) ? result.status.join(', ') : result.status) : 'none';
}
console.log(display(JSON.parse('{"status":["x",{"a":1}]}') as Result));
