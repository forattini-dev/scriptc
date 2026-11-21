class Base {}
function factory() {
  function before() { return typeof Definition; }
  const first = before();
  class Definition extends Base {}
  return first;
}
try { factory(); console.log("no error"); }
catch (error) { console.log(error instanceof ReferenceError); }
