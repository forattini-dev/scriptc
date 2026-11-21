const first = {
  name: "first",
  test: /a/,
};
const second = {
  name: "second",
  resolve: (value) => value.length,
};
const third = {
  name: "third",
  default: true,
};

const tail = [second];
const entries = [first].concat(tail, third);

exports.entries = entries;
