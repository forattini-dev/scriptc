/// <reference types="node" />
// @no-engine
import { createInterface } from "node:readline";
const silent = createInterface({ input: process.stdin, terminal: false });
silent.on("close", () => { console.log("silent closed"); });
silent.question("must not appear:", (answer: string) => { console.log(answer); });
silent.close();
const visible = createInterface({ input: process.stdin, output: process.stdout, terminal: false });
visible.on("close", () => { console.log("visible closed"); });
visible.question("prompt:", (answer: string) => { console.log(answer); });
visible.close();
