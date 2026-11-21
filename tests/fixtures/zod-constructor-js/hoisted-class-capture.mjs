class Base { constructor() { this.value = 11; } }
function factory() {
  function before() { return make(); }
  class Definition extends Base {}
  function make() { return new Definition(); }
  return before();
}
const result = factory();
console.log(result.value, result instanceof Base);
