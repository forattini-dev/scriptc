import { createInterface } from "node:readline";

async function main() {
  const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
  for await (const line of lines) {
    console.log(JSON.stringify(line));
  }
}

void main();
