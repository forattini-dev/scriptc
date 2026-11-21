import { RestBox } from './unsupported.js';
const value = new RestBox();
const read = value.read;
console.log(read.call(value, 'one', 'two'));
const dynamic: any = read;
const receiver: any = {};
console.log('empty', dynamic.call(receiver));
console.log('bound', dynamic.bind(receiver, 'first')('second', 'third'));
for (let i = 0; i < 32; i++) {
  let item: any = i;
  if ((i & 1) !== 0) item = undefined;
  if ((i & 2) !== 0) item = null;
  if ((i & 4) !== 0) item = false;
  if ((i & 8) !== 0) item = 'text';
  if ((i & 16) !== 0) item = true;
  console.log(i, dynamic.call(receiver, item, 'tail'), dynamic.apply(receiver, [item, 'tail']));
}
