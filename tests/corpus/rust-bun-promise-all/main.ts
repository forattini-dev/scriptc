// @rust-only
// @target bun
// @no-engine
const executable = process.env.SCRIPTC_NODE_ORACLE ?? "node";
const child = Bun.spawn([executable, "-e", 'process.stdout.write("  Hello 😀  ");process.stderr.write("  Warning  ");process.exitCode=7'], { stdout: "pipe", stderr: "pipe", stdin: "ignore" });
const [out, err, code] = await Promise.all([
  new Response(child.stdout).text(),
  new Response(child.stderr).text(),
  child.exited,
]);
console.log("combined", out.trim().toLowerCase(), err.trim(), code);
const next = Bun.spawn([executable, "-e", 'process.stdout.write("  DIRECT  ")'], { stderr: "ignore" });
console.log("direct", (await new Response(next.stdout).text()).trim().toLowerCase(), await next.exited);
const large = Bun.spawn([executable, "-e", 'process.stdout.write("o".repeat(2*1024*1024));process.stderr.write("e".repeat(2*1024*1024))'], { stderr: "pipe" });
const [largeOut, largeErr, largeCode] = await Promise.all([
  new Response(large.stdout).text(), new Response(large.stderr).text(), large.exited,
]);
console.log("large", largeOut.length, largeErr.length, largeCode);
export {};
