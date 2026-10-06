class Root { value() { return 1; } }
const registry = JSON.parse('{"x":1}');
class Picked extends registry.base {}
const picked = new Picked();
console.log(picked.value());
