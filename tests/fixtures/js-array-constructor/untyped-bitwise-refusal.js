function encode(value) {
  return value[0] << 24;
}
console.log(encode(JSON.parse("[1]")));
