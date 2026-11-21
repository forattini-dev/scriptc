import { Box } from './box.js';
function run() {
  const method = new Box('initial').read;
  for (let i = 0; i < 32; i++) {
    let value: any = i;
    if ((i & 1) !== 0) value = undefined;
    if ((i & 2) !== 0) value = null;
    if ((i & 4) !== 0) value = false;
    if ((i & 8) !== 0) value = 'text';
    if ((i & 16) !== 0) value = { nested: i };
    const receiver: any = { value };
    const result = method.call(receiver);
    console.log(i, typeof result, JSON.stringify(result));
  }
}
run();
