    /* node:string_decoder — StringDecoder over the Buffer shim: utf8
     * rides the prelude TextDecoder's streaming state machine,
     * utf16le holds byte parity, base64 carries mod-3 remainders. */
  builtins.string_decoder = memo(() => {
function makeStringDecoder(Buffer) {
  const normEnc = (enc) => {
    if (enc === undefined || enc === null) return "utf8";
    const e = String(enc).toLowerCase();
    if (e === "utf8" || e === "utf-8") return "utf8";
    if (e === "hex") return "hex";
    if (e === "base64") return "base64";
    if (e === "base64url") return "base64url";
    if (e === "latin1" || e === "binary") return "latin1";
    if (e === "ascii") return "ascii";
    if (e === "utf16le" || e === "utf-16le" || e === "ucs2" || e === "ucs-2") return "utf16le";
    const err = new TypeError("Unknown encoding: " + enc);
    err.code = "ERR_UNKNOWN_ENCODING";
    throw err;
  };
  class StringDecoder {
    constructor(encoding) {
      this.encoding = normEnc(encoding);
      if (this.encoding === "utf8") {
        this._dec = new TextDecoder();
      } else if (this.encoding === "utf16le") {
        this._oddByte = -1;
      } else if (this.encoding === "base64" || this.encoding === "base64url") {
        this._rem = null;
      }
    }
    write(buf) {
      if (typeof buf === "string") return buf;
      const u8 = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
      switch (this.encoding) {
        case "utf8":
          return this._dec.decode(u8, { stream: true });
        case "utf16le": {
          let bytes = u8;
          if (this._oddByte >= 0) {
            const joined = new Uint8Array(u8.length + 1);
            joined[0] = this._oddByte;
            joined.set(u8, 1);
            bytes = joined;
            this._oddByte = -1;
          }
          if (bytes.length % 2 !== 0) {
            this._oddByte = bytes[bytes.length - 1];
            bytes = bytes.subarray(0, bytes.length - 1);
          }
          return Buffer.from(bytes).toString("utf16le");
        }
        case "base64":
        case "base64url": {
          let bytes = u8;
          if (this._rem !== null) {
            const joined = new Uint8Array(this._rem.length + u8.length);
            joined.set(this._rem, 0);
            joined.set(u8, this._rem.length);
            bytes = joined;
            this._rem = null;
          }
          const usable = bytes.length - (bytes.length % 3);
          if (usable < bytes.length) {
            this._rem = bytes.slice(usable);
            bytes = bytes.subarray(0, usable);
          }
          return Buffer.from(bytes).toString(this.encoding);
        }
        default:
          return Buffer.from(u8).toString(this.encoding);
      }
    }
    end(buf) {
      let out = buf !== undefined ? this.write(buf) : "";
      switch (this.encoding) {
        case "utf8":
          out += this._dec.decode();
          this._dec = new TextDecoder();
          break;
        case "utf16le":
          this._oddByte = -1;
          break;
        case "base64":
        case "base64url":
          if (this._rem !== null) {
            out += Buffer.from(this._rem).toString(this.encoding);
            this._rem = null;
          }
          break;
      }
      return out;
    }
  }
  return { StringDecoder };
}
    const mod = makeStringDecoder(builtins.buffer().Buffer);
    mod.default = mod;
    return mod;
  });
