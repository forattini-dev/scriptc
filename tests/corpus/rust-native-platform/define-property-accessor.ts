const state = { value: 2 };
const object: any = {};

Object.defineProperty(object, "value", {
  get() {
    return state.value;
  },
  set(next: number) {
    state.value = next;
  },
  configurable: true,
});

object.value = 7;
console.log(object.value, state.value);
