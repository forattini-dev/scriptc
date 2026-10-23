// @rust-only
// @no-engine
export {};
// Native-only: the reference record adapter does not transport rest methods.
const object = {
  value: "rest",
  join(this: { value: string }, ...values: number[]): string {
    const prefix: string = this.value;
    return prefix + ":" + values.join(":");
  },
};
console.log("direct", object.join(1, 2, 3), object.join());
const join = object.join;
console.log("borrowed", join.call({ value: "other" }, 4, 5) === "other:4:5");
const copied = { ...object, value: "copy" };
console.log("copied", copied.join(6), object.join(7));
console.log("json", JSON.stringify(object) === '{"value":"rest"}');
