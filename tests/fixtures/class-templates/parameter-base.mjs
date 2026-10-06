class Base { value() { return 1; } }
function mix(base) {
  return class extends base { more() { return 2; } };
}
function run() { return new (mix(Base))().more(); }
console.log(run());
