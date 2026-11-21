function Box(value) {
  this.value = value;
}

function Replacement(value) {
  return { value: value + 1 };
}

const box = new Box(4);
Box.prototype.kind = "box";
const replacement = new Replacement(4);
console.log(box.value, box.kind, box.constructor === Box);
console.log(replacement.value);
