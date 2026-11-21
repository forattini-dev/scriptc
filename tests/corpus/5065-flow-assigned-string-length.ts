function encode(value: Uint8Array): string {
  let text: string;
  if (value.length > 1) {
    text = "abcdef";
  } else {
    text = String.fromCharCode(value[0]);
  }
  const width = Math.max(1, 3);
  const lines = new Array(Math.ceil(text.length / width));
  for (let index = 0; index < lines.length; index++) {
    lines[index] = text.substr(index * width, width);
  }
  return lines.join("|");
}

console.log(encode(new Uint8Array([1, 2])));
