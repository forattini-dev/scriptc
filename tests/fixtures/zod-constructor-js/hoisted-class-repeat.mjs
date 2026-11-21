class Base { constructor() { this.value = 11; } }
function factory() {
  function before() { return make(); }
  class Definition extends Base {}
  function make() { return new Definition(); }
  return before();
}
const first = factory();
const second = factory();
console.log(first.value, second.value, first.constructor === second.constructor, first instanceof Base, second instanceof Base);
