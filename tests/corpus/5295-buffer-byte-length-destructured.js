// @ts-nocheck
/// <reference types="node" />
function splitInput(input) {
  const start = input.indexOf("x");
  if (start === -1) return { complete: input, pending: "" };
  return {
    complete: input.slice(0, start),
    pending: input.slice(start),
  };
}

const { complete, pending } = splitInput("axb");
console.log(`${complete}|${pending}|${Buffer.byteLength(pending, "utf8")}`);
