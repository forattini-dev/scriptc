// @rust-only
// @no-engine

function encode(value) {
  return Buffer.from(value, "utf-8").toString("hex");
}

console.log(encode(JSON.parse('"hello ☃"')));
console.log(encode(JSON.parse('""')));
