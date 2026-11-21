type Result = { status?: string[] };
function array(result: Result): string[] {
  return result.status ? [Array.isArray(result.status) ? result.status.join(', ') : result.status] : [];
}
const input = JSON.parse('{"status":{"value":1}}') as Result;
const output = array(input);
console.log(JSON.stringify(output), typeof output[0]);
