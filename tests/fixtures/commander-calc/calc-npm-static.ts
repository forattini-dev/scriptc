// The --npm-static commander differential: package declarations preserve
// the public overloads while scriptc compiles commander's shipped JavaScript
// implementation. npm-static.test.ts runs `add 20 22` under Node and the
// native binary and compares stdout, stderr, and exit status byte-for-byte.
import { Command } from "commander";
const program = new Command();
program.name("calc");
const add = program.command("add <a> <b>");
add.description("add two numbers");
add.action((a: string, b: string) => {
  console.log(parseInt(a, 10) + parseInt(b, 10));
});
program.parse();
