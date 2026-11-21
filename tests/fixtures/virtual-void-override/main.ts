import { Base, Child } from './classes.js';
const log: string[] = [];
const values: any[] = [undefined, null, false, true, 0, 'forward', 'x', 'y'];
for (let i = 0; i < 32; i++) {
  const receiver: Base = i % 2 === 0 ? new Base(log) : new Child(log);
  receiver.run(values[i % values.length]);
}
try {
  const receiver: Base = new Child(log);
  receiver.run('throw');
} catch (error) {
  console.log('caught', error instanceof TypeError);
}
console.log(log.join('|'));
