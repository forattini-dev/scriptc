class Box {
  /** @param {string} value */
  constructor(value) { this["~value"] = value; }
  read() { return this["~value"]; }
  /** @param {string} value */
  write(value) { this["~value"] = value; }
}
const box = new Box("a");
console.log("first", box.read());
box.write("b");
console.log("second", box["~value"]);
