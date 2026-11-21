const inputs = ['[]', '[null]', '[false]', '[0]', '["text"]', '[{"n":1}]', '[[1,2]]', '[true]'];
function observe(values: string[], mode: number) {
  const json = JSON.stringify(values[0]);
  if (mode === 0) return typeof json;
  if (mode === 1) return json ? 'truthy' : 'falsy';
  if (mode === 2) return json === undefined ? 'undefined' : 'defined';
  return String(json);
}
for (const input of inputs) {
  for (let mode = 0; mode < 4; mode++) {
    try { console.log(input, mode, observe(JSON.parse(input) as string[], mode)); }
    catch (error) { console.log(input, mode, 'caught', error instanceof TypeError); }
  }
}
