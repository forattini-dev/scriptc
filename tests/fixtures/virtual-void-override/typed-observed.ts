import { Base, Child } from './typed-classes.js';
for (let i = 0; i < 32; i++) {
  const receiver: Base = i % 2 ? new Child() : new Base();
  const result = receiver.run(i) as any;
  console.log(i, typeof result, result === 42);
}
