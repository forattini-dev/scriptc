let AssignedClass;

const once = (factory, value) => () =>
  (factory && (value = factory(factory = 0)), value);

const initialize = once(() => {
  AssignedClass = class {
    value() {
      return 7;
    }
  };
});

initialize();
const first = AssignedClass;
initialize();
const second = AssignedClass;
const instance = new AssignedClass();

console.log(first === second, instance.value());
