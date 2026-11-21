/** @param {*} input */
function* linesFromString(input) {
  let start = 0;
  while (true) {
    const end = input.indexOf("\n", start);
    if (end === -1) {
      yield input.slice(start);
      return;
    }
    yield input.slice(start, end);
    start = end + 1;
  }
}

/** @param {Iterable<string>} lines */
function collect(lines) {
  const output = [];
  for (const line of lines) output.push(line);
  return output.join("|");
}

console.log(collect(linesFromString("first\nsecond")));
