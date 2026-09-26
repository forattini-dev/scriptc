// Strict reads from a shift result reuse the loop-local optional value directly. A longer first argument followed by a shorter one must not leave a conditionally evaluated receiver temporary dangling across iterations.
const args = ["--long", "x"];

while (args.length > 0) {
  const arg = args.shift();
  if (arg.length > 2 && arg[0] === "-") console.log(arg);
}
