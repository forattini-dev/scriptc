const operations = {
  square: (value) => value * value,
  multiply: (left, right) => left * right,
};
console.log("number", String(operations.square(3)));
console.log("bigint", String(operations.square(3n)));
console.log("multiply", String(operations.multiply(4n, 5n)));
try {
  operations.multiply(4n, 5);
} catch (error) {
  console.log("mixed", error instanceof TypeError, String(error.message));
}
