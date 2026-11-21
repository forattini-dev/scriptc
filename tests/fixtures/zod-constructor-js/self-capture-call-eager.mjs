function check(fn) { fn(); return { fn }; }
function run() {
  const ch = check(() => ch);
  return ch;
}
try { run(); console.log("no error"); }
catch (error) { console.log(error instanceof ReferenceError); }
