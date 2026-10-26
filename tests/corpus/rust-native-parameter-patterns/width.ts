type Input = { drop: number; child: { value: number }; callback: (n: number) => number };
const source = {drop: 1, child: {value: 2}, callback: (n: number) => n + 1, hidden: "retained", "10": "ten", "2": "two"};
function select({drop, ...rest}: Input): string {
  rest.child.value = 9;
  const callback = rest.callback;
  console.log("callback", callback(3));
  return Object.keys(rest).join("|");
}
console.log("width", select(source), source.child.value, Object.keys(source).join("|"));
