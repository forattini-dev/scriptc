// @rust-only
// @no-engine
export {};

const object: any = { value: 1 };
const data: any = Object.getOwnPropertyDescriptor(object, "value");
console.log(
  "data",
  data.value,
  data.writable,
  data.enumerable,
  data.configurable,
);
console.log(
  "missing",
  Object.getOwnPropertyDescriptor(object, "missing") === undefined,
);

Object.defineProperty(object, "lazy", {
  get() {
    return 7;
  },
  configurable: true,
});
const accessor: any = Object.getOwnPropertyDescriptor(object, "lazy");
console.log(
  "accessor",
  typeof accessor.get,
  accessor.set === undefined,
  accessor.enumerable,
  accessor.configurable,
);

const holder: any = { shape: { value: 3 } };
const existing: any = Object.getOwnPropertyDescriptor(holder, "shape");
if (!existing?.get) {
  const shape = holder.shape;
  Object.defineProperty(holder, "shape", {
    get: () => {
      const next = { ...shape };
      Object.defineProperty(holder, "shape", { value: next });
      return next;
    },
  });
}
console.log("arrow getter", holder.shape.value, holder.shape.value);
