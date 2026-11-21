import { AsyncBox } from './unsupported.js';
async function run() {
  const box = new AsyncBox();
  const read = box.read;
  const fail = box.fail;
  const receiver: any = {value: 'plain'};
  console.log('before');
  console.log('resolved', await read.call(receiver));
  console.log('number', await read.call({value: 42} as any));
  try { await fail.call(receiver); } catch (error) { console.log('rejected', error instanceof TypeError); }
  console.log('after');
}
void run();
