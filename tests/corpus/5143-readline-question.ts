/// <reference types="node" />
import * as readline from "node:readline";

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
  terminal: true,
});
rl.question("name? ", (answer) => {
  rl.close();
  console.log(answer.trim());
});
