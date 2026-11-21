import { Base, Child } from './async-classes.js';
const receiver: Base = Math.random() < 2 ? new Child() : new Base();
const result = receiver.run() as any;
console.log(typeof result.then);
