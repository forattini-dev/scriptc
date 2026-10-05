// @ts-nocheck
const constructStack = () => {
  let value = 0;
  const stack = {
    set: (next) => { value = next; },
    read: () => value,
    clone: () => constructStack(),
  };
  return stack;
};
class Client {
  stack = constructStack();
}
const first = new Client();
const second = new Client();
first.stack.set(7);
console.log(first.stack.read(), second.stack.read());
const clone = first.stack.clone();
clone.set(9);
console.log(clone.read(), first.stack.read());
