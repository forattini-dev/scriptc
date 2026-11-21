// @ts-nocheck
class Box { read() { return this["missing"]; } }
console.log("missing", new Box().read());
