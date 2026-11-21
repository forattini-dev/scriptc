import { Base, Child } from './unsafe-classes.js';
const receiver: Base = Math.random() < 2 ? new Base() : new Child();
console.log(receiver.run('preserved') as any);
