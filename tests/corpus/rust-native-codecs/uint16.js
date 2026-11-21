const values = new Uint16Array([0, 65535, 65536, -1, 3.5]);
console.log(values[0], values[1], values[2], values[3], values[4], values.byteLength);

const text = new Uint16Array("abc".split("").map((char) => char.charCodeAt(0)));
console.log(text[0], text[1], text[2], text.length, text.byteLength);
