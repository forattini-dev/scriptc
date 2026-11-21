/**
 * @param {(Buffer | string)[]} values
 * @returns {string[]}
 */
function normalize(values) {
  const result = [];
  for (let i = 0; i < values.length; i++) {
    const value = values[i];
    if (typeof value === "string") {
      result.push(value);
    } else {
      result.push(
        Array.isArray(value)
          ? value.map((part) => part.toString("latin1")).join(",")
          : value.toString("latin1"),
      );
    }
  }
  return result;
}

console.log(normalize(["Alpha", Buffer.from([66, 101, 116, 97])]).join("|"));
