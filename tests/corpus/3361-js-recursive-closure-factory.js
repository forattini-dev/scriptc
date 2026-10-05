// @ts-nocheck
const constructStack = () => {
  let count = 0;
  const stack = {
    increment: () => ++count,
    read: () => count,
    clone: () => constructStack(),
  };
  return stack;
};
class Client {
  stack = constructStack();
}
const first = new Client();
const second = new Client();
console.log(first.stack.increment(), first.stack.increment(), second.stack.increment());
console.log(first.stack === second.stack);
const clone = first.stack.clone();
console.log(clone.read(), clone.increment(), first.stack.read());
