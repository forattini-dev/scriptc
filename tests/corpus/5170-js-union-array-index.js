// @ts-nocheck
let previousLines = [];

function changed(text) {
  const nextLines = text.split("\n");
  let result = "";
  for (let i = 0; i < nextLines.length; i++) {
    if (nextLines[i] !== previousLines[i]) result += nextLines[i];
  }
  previousLines = nextLines;
  return result;
}

console.log(changed("a\nb"));
console.log(changed("a\nc"));
