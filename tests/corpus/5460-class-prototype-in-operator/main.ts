class Base {
  stream(): string {
    return "stream";
  }
}

class Candidate extends Base {
  own = 7;

  arrayBuffer(): string {
    return "buffer";
  }
}

const value = new Candidate();
console.log("own" in value, "stream" in value, "arrayBuffer" in value);
console.log("toString" in value, "missing" in value);

const buffer = Buffer.from([1, 2]);
console.log("copy" in buffer, "slice" in buffer, "length" in buffer, "stream" in buffer);

const typed = new Uint8Array(2);
console.log("set" in typed, "copy" in typed, "toString" in typed);
