const owner = Buffer.from([10, 20, 30, 40, 50])
const data = owner.subarray(1, 4)
const view = new Uint8Array(data.buffer, data.byteOffset, data.byteLength)

console.log(view.length, Array.from(view).join(","))
view[0] = 21
data[2] = 41
console.log(Array.from(owner).join(","), Array.from(view).join(","))
