const inputs = ['[]', '[null]', '[false]', '[0]', '["text"]', '[{"n":1}]', '[[1,2]]', '[true]'];
const stringify = JSON.stringify;
function observe(values: string[], mode: number) {
  if (mode === 0) {
    const json: string = JSON.stringify(values[0]);
    return typeof json;
  }
  if (mode === 1) {
    let json = stringify(values[0]);
    const before = typeof json;
    json = 'changed';
    return before + ':' + json;
  }
  if (mode === 2) {
    const json = JSON.stringify(values[0]);
    const read = () => typeof json;
    return read();
  }
  const json = stringify(values[0]);
  return JSON.stringify([json]);
}
for (const input of inputs) {
  for (let mode = 0; mode < 4; mode++) {
    try { console.log(input, mode, observe(JSON.parse(input) as string[], mode)); }
    catch (error) { console.log(input, mode, 'caught', error instanceof TypeError); }
  }
}
let reads = 0;
let live: any;
const source: any = { get value() { reads++; return live; } };
for (const input of inputs) {
  live = JSON.parse(input)[0];
  const json = JSON.stringify(source.value as string);
  console.log('getter', input, typeof json, String(json), reads);
}
