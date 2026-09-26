import assert from "node:assert/strict";

function show(label: string, fn: () => void): void {
  try {
    fn();
  } catch (error) {
    if (error instanceof Error) console.log(label, error.name, error.message);
  }
}

show("parse", () => { BigInt("12x"); });
show("number", () => { BigInt(1.5); });
show("divide", () => { 1n / 0n; });
show("power", () => { 2n ** -1n; });
show("radix", () => { (1n).toString(1); });
show("width", () => { BigInt.asUintN(-1, 1n); });

show("unsigned", () => { Buffer.alloc(8).writeBigUInt64BE(-1n); });
show("signed", () => { Buffer.alloc(8).writeBigInt64BE(1n << 63n); });
show("buffer-size", () => { Buffer.alloc(4).readBigUInt64BE(); });
show("buffer-offset", () => { Buffer.alloc(8).writeBigInt64BE(1n, 2); });

const view = new DataView(new ArrayBuffer(8));
show("dataview", () => { view.getBigInt64(1); });

show("assert-equal", () => { assert.equal(1n, 2n); });
show("assert-deep", () => { assert.deepEqual(1n, 2n); });
show("assert-not", () => { assert.notEqual(1n, 1n); });
