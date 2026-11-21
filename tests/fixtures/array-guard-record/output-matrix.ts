type Result = { status?: string[] };
function display(result: Result): { key: string; value: string }[] {
  return result.status
    ? [{ key: 'Status', value: Array.isArray(result.status) ? result.status.join(', ') : result.status }]
    : [];
}
function nested(result: Result): { value: string } {
  return { value: result.status ? (Array.isArray(result.status) ? result.status.join(', ') : result.status) : 'none' };
}
function array(result: Result): string[] {
  return result.status ? [Array.isArray(result.status) ? result.status.join(', ') : result.status] : [];
}
const cases = [
  '{"status":["one","two"]}', '{"status":[]}', '{"status":"ready"}', '{"status":null}',
  '{"status":false}', '{"status":0}', '{"status":{"value":1}}', '{"status":7}',
];
for (let round = 0; round < 4; round++) {
  for (const input of cases) {
    try {
      const output = display(JSON.parse(input) as Result);
      const wrapped = nested(JSON.parse(input) as Result);
      const elements = array(JSON.parse(input) as Result);
      console.log(round, JSON.stringify(output), output.length ? typeof output[0].value : 'empty', JSON.stringify(wrapped), typeof wrapped.value, JSON.stringify(elements), elements.length ? typeof elements[0] : 'empty');
    } catch (error) {
      console.log(round, 'caught', error instanceof TypeError);
    }
  }
}
