type Result = { status?: string[] };
function display(result: Result) {
  return result.status ? JSON.stringify(Array.isArray(result.status) ? result.status.join(', ') : result.status) : 'none';
}
const cases = [
  '{"status":["one","two"]}', '{"status":[]}', '{"status":"ready"}', '{"status":null}',
  '{"status":false}', '{"status":0}', '{"status":{"value":1}}', '{"status":7}',
  '{"status":["x",1,null,false,{"a":1}]}',
];
for (let round = 0; round < 4; round++) {
  for (const input of cases) {
    try { console.log(round, display(JSON.parse(input) as Result)); }
    catch (error) { console.log(round, 'caught', error instanceof TypeError); }
  }
}
