const source = Buffer.from([65, 66, 67]);
const tail = new Uint8Array([68, 69, 70]);
const result = Buffer.concat([source.subarray(1), tail.subarray(0, 2)]);
console.log("result", Buffer.isBuffer(result), result.toString("utf8"), result.indexOf(322));
source[1] = 90;
console.log("copied", result.toString("utf8"), Buffer.isBuffer(Buffer.concat([])));
