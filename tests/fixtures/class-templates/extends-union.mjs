class Root { value() { return 1; } }
function pick(left) {
  if (left === "left") { const A = class extends Root { a() { return 1; } }; return A; }
  const B = class extends Root { b() { return 2; } };
  return B;
}
class Picked extends pick("left") {}
const picked = new Picked();
console.log(picked.value());
