function check(fn) { return { fn, value: 7 }; }
function run() {
  const ch = check(() => ch);
  console.log(ch.fn() === ch, ch.fn().value);
}
run();
