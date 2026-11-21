/** @param {Iterable<string>} lines */
function consume(lines) {
  let result = "";
  for (const line of lines) result += line;
  return result;
}

function* lines() {
  yield "a";
  yield "b";
}

console.log(consume(lines()));
