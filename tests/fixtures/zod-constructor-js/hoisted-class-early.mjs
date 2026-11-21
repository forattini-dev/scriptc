class Base {}
function factory() {
  function before() { return make(); }
  const first = before();
  class Definition extends Base {}
  function make() { return new Definition(); }
  return first;
}
try { factory(); console.log("no error"); }
catch (error) { console.log(error instanceof ReferenceError); }
