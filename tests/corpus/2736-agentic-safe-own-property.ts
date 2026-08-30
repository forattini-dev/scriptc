const queue: Record<string, number | null> = {
  alpha: 2,
  held: null,
};

for (const key of ["alpha", "held", "missing", "toString"]) {
  console.log(key, Object.prototype.hasOwnProperty.call(queue, key));
}

console.log(
  Object.prototype.hasOwnProperty.call(queue, "alpha"),
  Object.prototype.hasOwnProperty.call(queue, "missing"),
);
