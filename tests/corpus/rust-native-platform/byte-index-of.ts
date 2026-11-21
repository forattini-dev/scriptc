const plain = new Uint8Array([10, 20, 10]);
const buffer = Buffer.from([10, 20, 10]);
console.log("plain", plain.indexOf(10), plain.indexOf(10, 1), plain.indexOf(266), plain.indexOf(10.5));
console.log("buffer", buffer.indexOf(10), buffer.indexOf(10, 1), buffer.indexOf(266), buffer.indexOf(10.5));
console.log("views", plain.subarray(1).indexOf(10), buffer.subarray(1).indexOf(266));
