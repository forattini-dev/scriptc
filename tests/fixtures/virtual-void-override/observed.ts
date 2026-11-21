import { Base, Child } from './classes.js';
const log: string[] = [];
const values: any[] = [undefined, null, false, true, 0, 1, 'forward', 'text'];
for (let i = 0; i < 32; i++) {
  const receiver: Base = i < 16 ? new Base(log) : new Child(log);
  const result = receiver.run(values[i % values.length]) as any;
  console.log(i, typeof result, JSON.stringify(result));
}
console.log(log.length);
