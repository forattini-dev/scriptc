type Dictionary = Record<string, string | null>;

const current: Dictionary = { present: null };
const alias = current;

console.log(
  "has own",
  Object.prototype.hasOwnProperty.call(current, "present"),
  Object.prototype.hasOwnProperty.call(current, "missing"),
  Object.hasOwn(alias, "present"),
);
