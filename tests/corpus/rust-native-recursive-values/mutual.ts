interface Left {
  name: string;
  right?: Right;
}
interface Right {
  value: number;
  left: Left;
}
const left: Left = { name: "left" };
const right: Right = { value: 42, left };
left.right = right;
console.log(right.left === left);
if (left.right !== undefined) {
  console.log(left.right.value, left.right.left.name);
}
