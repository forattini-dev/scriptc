// Synchronous descriptor shorthand and inline options normalize to the
// classic buffer-window behavior without changing evaluation order.
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const scratch = path.join(os.tmpdir(), `scr-2938-${process.pid}.txt`);
fs.writeFileSync(scratch, "0123456789");

/** @param {string} label @param {number} value @returns {number} */
function option(label, value) {
  console.log(label);
  return value;
}

let fd = fs.openSync(scratch, "r+");
const direct = Buffer.alloc(4, 46);
console.log("read defaults:", fs.readSync(fd, direct), direct.toString("utf8"));

const placed = Buffer.alloc(7, 46);
const placedCount = fs.readSync(fd, placed, {
  position: option("read position", 6),
  offset: option("read offset", 2),
  length: option("read length", 3),
});
console.log("read options:", placedCount, placed.toString("utf8"));

const remainder = Buffer.alloc(5, 46);
console.log("read option defaults:", fs.readSync(fd, remainder, { offset: 2 }), remainder.toString("utf8"));
fs.closeSync(fd);

fd = fs.openSync(scratch, "r+");
console.log("write defaults:", fs.writeSync(fd, Buffer.from("AB")));
console.log("write offset:", fs.writeSync(fd, Buffer.from("cdef"), 2));
const optionCount = fs.writeSync(fd, Buffer.from("WXYZ"), {
  position: option("write position", 7),
  offset: option("write offset", 1),
});
console.log("write options:", optionCount);
console.log("write option length:", fs.writeSync(fd, Buffer.from("QRST"), { length: 2 }));
console.log("write empty options:", fs.writeSync(fd, Buffer.from("!"), {}));
fs.closeSync(fd);

console.log("contents:", fs.readFileSync(scratch, "utf8"));
fs.unlinkSync(scratch);
