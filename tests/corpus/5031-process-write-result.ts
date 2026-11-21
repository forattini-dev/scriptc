/// <reference types="node" />
const write = (text: string): boolean => process.stdout.write(text);
console.log(write("x"));
