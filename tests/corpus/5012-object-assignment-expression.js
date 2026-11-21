let a = 0;
let b = "";
const source = { a: 2, b: "ready" };
const result = ({ a, b } = source);
console.log(a);
console.log(b);
console.log(result === source);
