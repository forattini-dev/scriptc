const order: string[] = [];
function value(label: string) {
  order.push(label);
  return () => label;
}

const left = Function.prototype.call(value("left"));
const right = Function.prototype.call(value("right"));
console.log(left === right, order.join(","));
