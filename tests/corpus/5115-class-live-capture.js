// @ts-nocheck
let Current;
const make = () => class {
  constructor() { this.value = Current; }
  read() { return Current; }
};
const Wrapper = make();
class First {}
class Second {}
Current = First;
const first = new Wrapper();
console.log(first.value === First);
console.log(first.read() === First);
Current = Second;
const second = new Wrapper();
console.log(second.value === Second);
console.log(first.value === First);
console.log(first.read() === Second);

function localCase() {
  let local;
  const factory = () => class {
    constructor() { this.value = local; }
    read() { return local; }
  };
  const Wrapper = factory();
  local = First;
  const value = new Wrapper();
  console.log(value.value === First);
  local = Second;
  console.log(value.read() === Second);
}
localCase();

let counter = 0;
function bump() { counter++; return 5; }
const Counter = (() => class {
  read() { return counter + bump() + counter; }
})();
console.log(new Counter().read());
