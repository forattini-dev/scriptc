    /* node:buffer — Buffer as a Uint8Array subclass carrying Node's
     * surface (from/alloc/concat, the seven encodings, read/write
     * accessors, indexOf/fill/copy/swap, the <Buffer ..> custom
     * inspect), developed standalone and differentially tested
     * against real Node. Also exposed as the Buffer GLOBAL below,
     * exactly like Node. */
  builtins.buffer = memo(() => {
function makeBuffer() {
  const K_MAX_LENGTH = 9007199254740991;
  const K_STRING_MAX_LENGTH = 536870888;
  const INSPECT_MAX_BYTES = 50;
  const utf8Enc = new TextEncoder();
  const utf8Dec = new TextDecoder();
  const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  const B64U = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
  const b64Val = (() => {
    const t = new Int8Array(256).fill(-1);
    for (let i = 0; i < 64; i++) t[B64.charCodeAt(i)] = i;
    t["-".charCodeAt(0)] = 62;
    t["_".charCodeAt(0)] = 63;
    return t;
  })();
  const normEnc = (enc) => {
    if (enc === undefined || enc === null) return "utf8";
    let e = String(enc).toLowerCase();
    if (e === "utf8" || e === "utf-8") return "utf8";
    if (e === "hex") return "hex";
    if (e === "base64") return "base64";
    if (e === "base64url") return "base64url";
    if (e === "latin1" || e === "binary") return "latin1";
    if (e === "ascii") return "ascii";
    if (e === "utf16le" || e === "utf-16le" || e === "ucs2" || e === "ucs-2") return "utf16le";
    return null;
  };
  const badEnc = (enc) => {
    const e = new TypeError("Unknown encoding: " + enc);
    e.code = "ERR_UNKNOWN_ENCODING";
    return e;
  };
  const outOfRange = (name, range, received) => {
    const e = new RangeError('The value of "' + name + '" is out of range. It must be ' + range + ". Received " + received);
    e.code = "ERR_OUT_OF_RANGE";
    return e;
  };
  const invalidBufferSize = (bits) => {
    const e = new RangeError("Buffer size must be a multiple of " + bits + "-bits");
    e.code = "ERR_INVALID_BUFFER_SIZE";
    return e;
  };
  const invalidArg = (name, expected, actual) => {
    const t = actual === null ? "null" : typeof actual === "object" ? "an instance of " + (actual.constructor && actual.constructor.name || "Object") : typeof actual === "string" ? "type string ('" + actual + "')" : "type " + typeof actual + " (" + String(actual) + ")";
    const label = name === "first argument" ? "The first argument" : 'The "' + name + '" argument';
    const e = new TypeError(label + " must be " + expected + ". Received " + t);
    e.code = "ERR_INVALID_ARG_TYPE";
    return e;
  };
  const encUtf8 = (s) => utf8Enc.encode(s);
  const encLatin1 = (s) => {
    const out = new Uint8Array(s.length);
    for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i) & 0xff;
    return out;
  };
  const encHex = (s) => {
    const n = s.length >>> 1;
    const out = new Uint8Array(n);
    let i = 0;
    for (; i < n; i++) {
      const b = parseInt(s.substr(i * 2, 2), 16);
      if (Number.isNaN(b) || !/^[0-9a-fA-F]{2}$/.test(s.substr(i * 2, 2))) break;
      out[i] = b;
    }
    return i === n ? out : out.subarray(0, i);
  };
  const encB64 = (s) => {
    const str = String(s);
    const vals = [];
    for (let i = 0; i < str.length; i++) {
      if (str[i] === "=") break;
      const v = b64Val[str.charCodeAt(i)];
      if (v >= 0) vals.push(v);
    }
    const n = Math.floor((vals.length * 6) / 8);
    const out = new Uint8Array(n);
    let buf = 0;
    let bits = 0;
    let o = 0;
    for (let i = 0; i < vals.length; i++) {
      buf = (buf << 6) | vals[i];
      bits += 6;
      if (bits >= 8) {
        bits -= 8;
        out[o++] = (buf >> bits) & 0xff;
      }
    }
    return out;
  };
  const encUtf16 = (s) => {
    const out = new Uint8Array(s.length * 2);
    for (let i = 0; i < s.length; i++) {
      const c = s.charCodeAt(i);
      out[i * 2] = c & 0xff;
      out[i * 2 + 1] = c >>> 8;
    }
    return out;
  };
  const encodeStr = (s, enc) => {
    switch (enc) {
      case "utf8": return encUtf8(s);
      case "latin1": case "ascii": return encLatin1(s);
      case "hex": return encHex(s);
      case "base64": case "base64url": return encB64(s);
      case "utf16le": return encUtf16(s);
    }
  };
  const hexChars = "0123456789abcdef";
  const decHex = (u8, start, end) => {
    let out = "";
    for (let i = start; i < end; i++) {
      out += hexChars[u8[i] >> 4] + hexChars[u8[i] & 0x0f];
    }
    return out;
  };
  const decLatin1 = (u8, start, end) => {
    let out = "";
    for (let i = start; i < end; i += 4096) {
      out += String.fromCharCode.apply(null, u8.subarray(i, Math.min(i + 4096, end)));
    }
    return out;
  };
  const decAscii = (u8, start, end) => {
    let out = "";
    for (let i = start; i < end; i++) out += String.fromCharCode(u8[i] & 0x7f);
    return out;
  };
  const decB64 = (u8, start, end, url) => {
    const alpha = url ? B64U : B64;
    let out = "";
    for (let i = start; i < end; i += 3) {
      const b0 = u8[i];
      const has1 = i + 1 < end;
      const has2 = i + 2 < end;
      const b1 = has1 ? u8[i + 1] : 0;
      const b2 = has2 ? u8[i + 2] : 0;
      const v = (b0 << 16) | (b1 << 8) | b2;
      out += alpha[(v >> 18) & 63];
      out += alpha[(v >> 12) & 63];
      if (has1) out += alpha[(v >> 6) & 63];
      else if (!url) out += "=";
      if (has2) out += alpha[v & 63];
      else if (!url) out += "=";
    }
    return out;
  };
  const decUtf16 = (u8, start, end) => {
    let out = "";
    const n = start + ((end - start) & ~1);
    for (let i = start; i < n; i += 2) {
      out += String.fromCharCode(u8[i] | (u8[i + 1] << 8));
    }
    return out;
  };
  const decodeBytes = (u8, enc, start, end) => {
    if (start < 0) start = 0;
    if (end > u8.length) end = u8.length;
    if (end <= start) return "";
    switch (enc) {
      case "utf8": return utf8Dec.decode(u8.subarray(start, end));
      case "latin1": return decLatin1(u8, start, end);
      case "ascii": return decAscii(u8, start, end);
      case "hex": return decHex(u8, start, end);
      case "base64": return decB64(u8, start, end, false);
      case "base64url": return decB64(u8, start, end, true);
      case "utf16le": return decUtf16(u8, start, end);
    }
  };
  const checkOffset = (buf, offset, ext) => {
    if (!Number.isInteger(offset)) throw outOfRange("offset", "an integer", offset);
    if (offset < 0 || offset + ext > buf.length) {
      if (buf.length - ext < 0) {
        const e = new RangeError("Attempt to access memory outside buffer bounds");
        e.code = "ERR_BUFFER_OUT_OF_BOUNDS";
        throw e;
      }
      throw outOfRange("offset", ">= 0 and <= " + (buf.length - ext), offset);
    }
  };
  const checkValue = (value, min, max, name) => {
    if (value < min || value > max) {
      throw outOfRange(name, ">= " + min + " and <= " + max, value);
    }
  };
  class Buffer extends Uint8Array {
    static alloc(size, fill, encoding) {
      if (typeof size !== "number" || Number.isNaN(size)) throw invalidArg("size", "of type number", size);
      if (size < 0 || size > K_MAX_LENGTH) throw outOfRange("size", ">= 0 && <= " + K_MAX_LENGTH, size);
      const b = new Buffer(size);
      if (fill !== undefined && fill !== 0) b.fill(fill, 0, b.length, encoding);
      return b;
    }
    static allocUnsafe(size) {
      return Buffer.alloc(size);
    }
    static allocUnsafeSlow(size) {
      return Buffer.alloc(size);
    }
    static from(value, encodingOrOffset, length) {
      if (typeof value === "string") {
        const enc = normEnc(encodingOrOffset);
        if (enc === null) throw badEnc(encodingOrOffset);
        const u8 = encodeStr(value, enc);
        return new Buffer(u8.buffer, u8.byteOffset, u8.length);
      }
      if (value instanceof ArrayBuffer || (typeof SharedArrayBuffer !== "undefined" && value instanceof SharedArrayBuffer)) {
        return new Buffer(value, encodingOrOffset, length);
      }
      if (ArrayBuffer.isView(value)) {
        if (value instanceof Uint8Array) {
          const copy = new Buffer(value.length);
          copy.set(value);
          return copy;
        }
        return new Buffer(Uint8Array.from(value).buffer);
      }
      if (value === null || value === undefined) throw invalidArg("first argument", "of type string or an instance of Buffer, ArrayBuffer, or Array or an Array-like Object", value);
      if (typeof value === "object") {
        if (typeof value.length === "number") {
          const n = Math.max(0, Math.floor(value.length) || 0);
          const b = new Buffer(n);
          for (let i = 0; i < n; i++) b[i] = value[i] & 0xff;
          return b;
        }
        if (value.type === "Buffer" && Array.isArray(value.data)) {
          return Buffer.from(value.data);
        }
        const prim = value.valueOf && value.valueOf();
        if (prim !== null && prim !== undefined && prim !== value) return Buffer.from(prim, encodingOrOffset, length);
      }
      throw invalidArg("first argument", "of type string or an instance of Buffer, ArrayBuffer, or Array or an Array-like Object", value);
    }
    static isBuffer(b) {
      return b instanceof Buffer;
    }
    static isEncoding(enc) {
      return typeof enc === "string" && normEnc(enc) !== null;
    }
    static byteLength(value, encoding) {
      if (value instanceof ArrayBuffer || ArrayBuffer.isView(value)) return value.byteLength;
      if (typeof value !== "string") throw invalidArg("string", "of type string or an instance of Buffer or ArrayBuffer", value);
      const enc = normEnc(encoding);
      switch (enc) {
        case "latin1": case "ascii": return value.length;
        case "utf16le": return value.length * 2;
        case "hex": return value.length >>> 1;
        case "base64": case "base64url": {
          let n = value.length;
          while (n > 0 && (value[n - 1] === "=" || value[n - 1] === " " || value[n - 1] === "\n" || value[n - 1] === "\r")) n--;
          return Math.floor((n * 6) / 8);
        }
        default: return encUtf8(value).length;
      }
    }
    static concat(list, totalLength) {
      if (!Array.isArray(list)) throw invalidArg("list", "an instance of Array", list);
      if (list.length === 0) return new Buffer(0);
      let total = totalLength;
      if (total === undefined) {
        total = 0;
        for (const b of list) total += b.length;
      }
      const out = new Buffer(total);
      let o = 0;
      for (const b of list) {
        if (o >= total) break;
        const chunk = b.length + o > total ? b.subarray(0, total - o) : b;
        out.set(chunk, o);
        o += chunk.length;
      }
      return out;
    }
    static compare(a, b) {
      return a.compare(b);
    }
    toString(encoding, start, end) {
      const enc = normEnc(encoding);
      if (enc === null) throw badEnc(encoding);
      return decodeBytes(this, enc, start === undefined ? 0 : Math.floor(start), end === undefined ? this.length : Math.min(Math.floor(end), this.length));
    }
    toJSON() {
      return { type: "Buffer", data: Array.prototype.slice.call(this) };
    }
    equals(other) {
      if (!(other instanceof Uint8Array)) throw invalidArg("otherBuffer", "an instance of Buffer or Uint8Array", other);
      if (this === other) return true;
      if (this.length !== other.length) return false;
      for (let i = 0; i < this.length; i++) {
        if (this[i] !== other[i]) return false;
      }
      return true;
    }
    compare(target, targetStart, targetEnd, sourceStart, sourceEnd) {
      if (!(target instanceof Uint8Array)) throw invalidArg("target", "an instance of Buffer or Uint8Array", target);
      const ts = targetStart === undefined ? 0 : targetStart;
      const te = targetEnd === undefined ? target.length : targetEnd;
      const ss = sourceStart === undefined ? 0 : sourceStart;
      const se = sourceEnd === undefined ? this.length : sourceEnd;
      const a = this.subarray(ss, se);
      const b = target.subarray(ts, te);
      const n = Math.min(a.length, b.length);
      for (let i = 0; i < n; i++) {
        if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1;
      }
      return a.length === b.length ? 0 : a.length < b.length ? -1 : 1;
    }
    copy(target, targetStart, sourceStart, sourceEnd) {
      const ts = targetStart === undefined ? 0 : targetStart;
      const ss = sourceStart === undefined ? 0 : sourceStart;
      let se = sourceEnd === undefined ? this.length : sourceEnd;
      if (se > this.length) se = this.length;
      const n = Math.min(se - ss, target.length - ts);
      if (n <= 0) return 0;
      target.set(this.subarray(ss, ss + n), ts);
      return n;
    }
    fill(value, start, end, encoding) {
      let s = 0;
      let e = this.length;
      let enc = encoding;
      if (typeof start === "string") {
        enc = start;
      } else {
        if (start !== undefined) s = start;
        if (typeof end === "string") enc = end;
        else if (end !== undefined) e = end;
      }
      if (typeof value === "number") {
        Uint8Array.prototype.fill.call(this, value & 0xff, s, e);
        return this;
      }
      let pattern;
      if (typeof value === "string") {
        const ne = normEnc(enc);
        if (ne === null) throw badEnc(enc);
        pattern = encodeStr(value, ne);
      } else if (value instanceof Uint8Array) {
        pattern = value;
      } else {
        throw invalidArg("value", "of type string or number or an instance of Buffer or Uint8Array", value);
      }
      if (pattern.length === 0) {
        Uint8Array.prototype.fill.call(this, 0, s, e);
        return this;
      }
      for (let i = s; i < e; i++) this[i] = pattern[(i - s) % pattern.length];
      return this;
    }
    write(string, offset, length, encoding) {
      if (typeof string !== "string") throw invalidArg("string", "of type string", string);
      let off = 0;
      let len;
      let enc = "utf8";
      if (offset === undefined) {
        len = this.length;
      } else if (typeof offset === "string") {
        enc = normEnc(offset);
        if (enc === null) throw badEnc(offset);
        len = this.length;
      } else {
        off = offset;
        if (length === undefined) {
          len = this.length - off;
        } else if (typeof length === "string") {
          enc = normEnc(length);
          if (enc === null) throw badEnc(length);
          len = this.length - off;
        } else {
          len = length;
          if (encoding !== undefined) {
            enc = normEnc(encoding);
            if (enc === null) throw badEnc(encoding);
          }
        }
      }
      if (off < 0 || off > this.length) throw outOfRange("offset", ">= 0 and <= " + this.length, off);
      const bytes = encodeStr(string, enc);
      let n = Math.min(bytes.length, len, this.length - off);
      if (enc === "utf16le") n &= ~1;
      if (enc === "utf8" && n < bytes.length) {
        while (n > 0 && (bytes[n] & 0xc0) === 0x80) n--;
      }
      this.set(bytes.subarray(0, n), off);
      return n;
    }
    slice(start, end) {
      return this.subarray(start, end);
    }
    toLocaleString(...args) {
      return this.toString(...args);
    }
    inspect() {
      return this[Symbol.for("nodejs.util.inspect.custom")]();
    }
    [Symbol.for("nodejs.util.inspect.custom")]() {
      const max = Math.min(this.length, INSPECT_MAX_BYTES);
      let out = "<Buffer ";
      for (let i = 0; i < max; i++) {
        out += (i ? " " : "") + hexChars[this[i] >> 4] + hexChars[this[i] & 0x0f];
      }
      if (this.length > max) {
        const rest = this.length - max;
        out += " ... " + rest + " more byte" + (rest > 1 ? "s" : "");
      }
      return out + ">";
    }
    indexOf(needle, byteOffset, encoding) {
      return bufIndexOf(this, needle, byteOffset, encoding, true);
    }
    lastIndexOf(needle, byteOffset, encoding) {
      return bufIndexOf(this, needle, byteOffset, encoding, false);
    }
    includes(needle, byteOffset, encoding) {
      return this.indexOf(needle, byteOffset, encoding) !== -1;
    }
    swap16() {
      if (this.length % 2 !== 0) throw invalidBufferSize("16");
      for (let i = 0; i < this.length; i += 2) {
        const t = this[i];
        this[i] = this[i + 1];
        this[i + 1] = t;
      }
      return this;
    }
    swap32() {
      if (this.length % 4 !== 0) throw invalidBufferSize("32");
      for (let i = 0; i < this.length; i += 4) {
        let t = this[i];
        this[i] = this[i + 3];
        this[i + 3] = t;
        t = this[i + 1];
        this[i + 1] = this[i + 2];
        this[i + 2] = t;
      }
      return this;
    }
    swap64() {
      if (this.length % 8 !== 0) throw invalidBufferSize("64");
      for (let i = 0; i < this.length; i += 8) {
        for (let j = 0; j < 4; j++) {
          const t = this[i + j];
          this[i + j] = this[i + 7 - j];
          this[i + 7 - j] = t;
        }
      }
      return this;
    }
    readUInt8(offset = 0) { checkOffset(this, offset, 1); return this[offset]; }
    readUInt16LE(offset = 0) { checkOffset(this, offset, 2); return this[offset] | (this[offset + 1] << 8); }
    readUInt16BE(offset = 0) { checkOffset(this, offset, 2); return (this[offset] << 8) | this[offset + 1]; }
    readUInt32LE(offset = 0) { checkOffset(this, offset, 4); return (this[offset] | (this[offset + 1] << 8) | (this[offset + 2] << 16)) + this[offset + 3] * 0x1000000; }
    readUInt32BE(offset = 0) { checkOffset(this, offset, 4); return this[offset] * 0x1000000 + ((this[offset + 1] << 16) | (this[offset + 2] << 8) | this[offset + 3]); }
    readInt8(offset = 0) { checkOffset(this, offset, 1); return (this[offset] << 24) >> 24; }
    readInt16LE(offset = 0) { checkOffset(this, offset, 2); return ((this[offset] | (this[offset + 1] << 8)) << 16) >> 16; }
    readInt16BE(offset = 0) { checkOffset(this, offset, 2); return (((this[offset] << 8) | this[offset + 1]) << 16) >> 16; }
    readInt32LE(offset = 0) { checkOffset(this, offset, 4); return this[offset] | (this[offset + 1] << 8) | (this[offset + 2] << 16) | (this[offset + 3] << 24); }
    readInt32BE(offset = 0) { checkOffset(this, offset, 4); return (this[offset] << 24) | (this[offset + 1] << 16) | (this[offset + 2] << 8) | this[offset + 3]; }
    readUIntLE(offset, byteLength) {
      checkOffset(this, offset, byteLength);
      let v = 0;
      let mul = 1;
      for (let i = 0; i < byteLength; i++) {
        v += this[offset + i] * mul;
        mul *= 0x100;
      }
      return v;
    }
    readUIntBE(offset, byteLength) {
      checkOffset(this, offset, byteLength);
      let v = 0;
      for (let i = 0; i < byteLength; i++) v = v * 0x100 + this[offset + i];
      return v;
    }
    readIntLE(offset, byteLength) {
      const v = this.readUIntLE(offset, byteLength);
      const limit = Math.pow(2, 8 * byteLength - 1);
      return v >= limit ? v - limit * 2 : v;
    }
    readIntBE(offset, byteLength) {
      const v = this.readUIntBE(offset, byteLength);
      const limit = Math.pow(2, 8 * byteLength - 1);
      return v >= limit ? v - limit * 2 : v;
    }
    readBigUInt64LE(offset = 0) {
      checkOffset(this, offset, 8);
      return new DataView(this.buffer, this.byteOffset, this.byteLength).getBigUint64(offset, true);
    }
    readBigUInt64BE(offset = 0) {
      checkOffset(this, offset, 8);
      return new DataView(this.buffer, this.byteOffset, this.byteLength).getBigUint64(offset, false);
    }
    readBigInt64LE(offset = 0) {
      checkOffset(this, offset, 8);
      return new DataView(this.buffer, this.byteOffset, this.byteLength).getBigInt64(offset, true);
    }
    readBigInt64BE(offset = 0) {
      checkOffset(this, offset, 8);
      return new DataView(this.buffer, this.byteOffset, this.byteLength).getBigInt64(offset, false);
    }
    readFloatLE(offset = 0) {
      checkOffset(this, offset, 4);
      return new DataView(this.buffer, this.byteOffset, this.byteLength).getFloat32(offset, true);
    }
    readFloatBE(offset = 0) {
      checkOffset(this, offset, 4);
      return new DataView(this.buffer, this.byteOffset, this.byteLength).getFloat32(offset, false);
    }
    readDoubleLE(offset = 0) {
      checkOffset(this, offset, 8);
      return new DataView(this.buffer, this.byteOffset, this.byteLength).getFloat64(offset, true);
    }
    readDoubleBE(offset = 0) {
      checkOffset(this, offset, 8);
      return new DataView(this.buffer, this.byteOffset, this.byteLength).getFloat64(offset, false);
    }
    writeUInt8(value, offset = 0) {
      checkOffset(this, offset, 1);
      checkValue(value, 0, 0xff, "value");
      this[offset] = value;
      return offset + 1;
    }
    writeUInt16LE(value, offset = 0) {
      checkOffset(this, offset, 2);
      checkValue(value, 0, 0xffff, "value");
      this[offset] = value & 0xff;
      this[offset + 1] = value >>> 8;
      return offset + 2;
    }
    writeUInt16BE(value, offset = 0) {
      checkOffset(this, offset, 2);
      checkValue(value, 0, 0xffff, "value");
      this[offset] = value >>> 8;
      this[offset + 1] = value & 0xff;
      return offset + 2;
    }
    writeUInt32LE(value, offset = 0) {
      checkOffset(this, offset, 4);
      checkValue(value, 0, 0xffffffff, "value");
      this[offset] = value & 0xff;
      this[offset + 1] = (value >>> 8) & 0xff;
      this[offset + 2] = (value >>> 16) & 0xff;
      this[offset + 3] = (value >>> 24) & 0xff;
      return offset + 4;
    }
    writeUInt32BE(value, offset = 0) {
      checkOffset(this, offset, 4);
      checkValue(value, 0, 0xffffffff, "value");
      this[offset] = (value >>> 24) & 0xff;
      this[offset + 1] = (value >>> 16) & 0xff;
      this[offset + 2] = (value >>> 8) & 0xff;
      this[offset + 3] = value & 0xff;
      return offset + 4;
    }
    writeInt8(value, offset = 0) {
      checkOffset(this, offset, 1);
      checkValue(value, -0x80, 0x7f, "value");
      this[offset] = value & 0xff;
      return offset + 1;
    }
    writeInt16LE(value, offset = 0) {
      checkOffset(this, offset, 2);
      checkValue(value, -0x8000, 0x7fff, "value");
      this[offset] = value & 0xff;
      this[offset + 1] = (value >>> 8) & 0xff;
      return offset + 2;
    }
    writeInt16BE(value, offset = 0) {
      checkOffset(this, offset, 2);
      checkValue(value, -0x8000, 0x7fff, "value");
      this[offset] = (value >>> 8) & 0xff;
      this[offset + 1] = value & 0xff;
      return offset + 2;
    }
    writeInt32LE(value, offset = 0) {
      checkOffset(this, offset, 4);
      checkValue(value, -0x80000000, 0x7fffffff, "value");
      new DataView(this.buffer, this.byteOffset, this.byteLength).setInt32(offset, value, true);
      return offset + 4;
    }
    writeInt32BE(value, offset = 0) {
      checkOffset(this, offset, 4);
      checkValue(value, -0x80000000, 0x7fffffff, "value");
      new DataView(this.buffer, this.byteOffset, this.byteLength).setInt32(offset, value, false);
      return offset + 4;
    }
    writeBigUInt64LE(value, offset = 0) {
      checkOffset(this, offset, 8);
      new DataView(this.buffer, this.byteOffset, this.byteLength).setBigUint64(offset, value, true);
      return offset + 8;
    }
    writeBigUInt64BE(value, offset = 0) {
      checkOffset(this, offset, 8);
      new DataView(this.buffer, this.byteOffset, this.byteLength).setBigUint64(offset, value, false);
      return offset + 8;
    }
    writeBigInt64LE(value, offset = 0) {
      checkOffset(this, offset, 8);
      new DataView(this.buffer, this.byteOffset, this.byteLength).setBigInt64(offset, value, true);
      return offset + 8;
    }
    writeBigInt64BE(value, offset = 0) {
      checkOffset(this, offset, 8);
      new DataView(this.buffer, this.byteOffset, this.byteLength).setBigInt64(offset, value, false);
      return offset + 8;
    }
    writeFloatLE(value, offset = 0) {
      checkOffset(this, offset, 4);
      new DataView(this.buffer, this.byteOffset, this.byteLength).setFloat32(offset, value, true);
      return offset + 4;
    }
    writeFloatBE(value, offset = 0) {
      checkOffset(this, offset, 4);
      new DataView(this.buffer, this.byteOffset, this.byteLength).setFloat32(offset, value, false);
      return offset + 4;
    }
    writeDoubleLE(value, offset = 0) {
      checkOffset(this, offset, 8);
      new DataView(this.buffer, this.byteOffset, this.byteLength).setFloat64(offset, value, true);
      return offset + 8;
    }
    writeDoubleBE(value, offset = 0) {
      checkOffset(this, offset, 8);
      new DataView(this.buffer, this.byteOffset, this.byteLength).setFloat64(offset, value, false);
      return offset + 8;
    }
    writeUIntLE(value, offset, byteLength) {
      checkOffset(this, offset, byteLength);
      let v = value;
      for (let i = 0; i < byteLength; i++) {
        this[offset + i] = v & 0xff;
        v = Math.floor(v / 0x100);
      }
      return offset + byteLength;
    }
    writeUIntBE(value, offset, byteLength) {
      checkOffset(this, offset, byteLength);
      let v = value;
      for (let i = byteLength - 1; i >= 0; i--) {
        this[offset + i] = v & 0xff;
        v = Math.floor(v / 0x100);
      }
      return offset + byteLength;
    }
    writeIntLE(value, offset, byteLength) {
      return this.writeUIntLE(value < 0 ? value + Math.pow(2, 8 * byteLength) : value, offset, byteLength);
    }
    writeIntBE(value, offset, byteLength) {
      return this.writeUIntBE(value < 0 ? value + Math.pow(2, 8 * byteLength) : value, offset, byteLength);
    }
  }
  Buffer.poolSize = 8192;
    /* Node's Buffer is an ordinary function whose statics are ASSIGNED
     * (Buffer.isBuffer = ...), so they are enumerable and `for (key in
     * Buffer)` walks them. A `class` declaration makes its statics
     * non-enumerable, and packages that COPY the static surface that way
     * would silently inherit an empty one — safer-buffer does exactly
     * this, and it sits under iconv-lite → raw-body → body-parser, so an
     * express app parsing a JSON body would hit `Buffer.isBuffer is not a
     * function` deep inside a decoder. Republish each static as
     * enumerable so the copy sees what Node's copy sees. */
  for (const k of Object.getOwnPropertyNames(Buffer)) {
    if (k === 'length' || k === 'name' || k === 'prototype') continue;
    const d = Object.getOwnPropertyDescriptor(Buffer, k);
    if (d === undefined || d.enumerable || !d.configurable) continue;
    d.enumerable = true;
    Object.defineProperty(Buffer, k, d);
  }
  const bufIndexOf = (buf, needle, byteOffset, encoding, first) => {
    let enc = "utf8";
    let start = first ? 0 : buf.length - 1;
    if (typeof byteOffset === "string") {
      enc = normEnc(byteOffset);
      if (enc === null) throw badEnc(byteOffset);
    } else if (byteOffset !== undefined) {
      start = Math.trunc(byteOffset);
      if (Number.isNaN(start)) start = first ? 0 : buf.length - 1;
      if (start < 0) start = buf.length + start;
      if (encoding !== undefined) {
        enc = normEnc(encoding);
        if (enc === null) throw badEnc(encoding);
      }
    }
    let pat;
    if (typeof needle === "number") {
      const b = needle & 0xff;
      if (first) {
        for (let i = Math.max(0, start); i < buf.length; i++) {
          if (buf[i] === b) return i;
        }
      } else {
        for (let i = Math.min(start, buf.length - 1); i >= 0; i--) {
          if (buf[i] === b) return i;
        }
      }
      return -1;
    }
    if (typeof needle === "string") pat = encodeStr(needle, enc);
    else if (needle instanceof Uint8Array) pat = needle;
    else throw invalidArg("value", "of type string or an instance of Buffer or Uint8Array", needle);
    if (pat.length === 0) {
      if (first) return start < 0 ? 0 : start > buf.length ? buf.length : start;
      return start < 0 ? 0 : Math.min(start, buf.length);
    }
    const match = (i) => {
      for (let j = 0; j < pat.length; j++) {
        if (buf[i + j] !== pat[j]) return false;
      }
      return true;
    };
    if (first) {
      for (let i = Math.max(0, start); i <= buf.length - pat.length; i++) {
        if (match(i)) return i;
      }
    } else {
      for (let i = Math.min(start, buf.length - pat.length); i >= 0; i--) {
        if (match(i)) return i;
      }
    }
    return -1;
  };
  function SlowBuffer(size) { return Buffer.alloc(size); }
  const isAscii = (input) => {
    const u8 = input instanceof Uint8Array ? input : new Uint8Array(input);
    for (let i = 0; i < u8.length; i++) {
      if (u8[i] > 0x7f) return false;
    }
    return true;
  };
  const isUtf8 = (input) => {
    const u8 = input instanceof Uint8Array ? input : new Uint8Array(input);
    let i = 0;
    while (i < u8.length) {
      const b = u8[i];
      let n = 0;
      let min = 0;
      let cp = 0;
      if (b < 0x80) { i++; continue; }
      else if ((b & 0xe0) === 0xc0) { n = 1; min = 0x80; cp = b & 0x1f; }
      else if ((b & 0xf0) === 0xe0) { n = 2; min = 0x800; cp = b & 0x0f; }
      else if ((b & 0xf8) === 0xf0) { n = 3; min = 0x10000; cp = b & 0x07; }
      else return false;
      if (i + n >= u8.length + 1 && i + n > u8.length) return false;
      for (let j = 1; j <= n; j++) {
        if (i + j >= u8.length || (u8[i + j] & 0xc0) !== 0x80) return false;
        cp = (cp << 6) | (u8[i + j] & 0x3f);
      }
      if (cp < min || cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff)) return false;
      i += n + 1;
    }
    return true;
  };
  return {
    Buffer,
    SlowBuffer,
    INSPECT_MAX_BYTES,
    kMaxLength: K_MAX_LENGTH,
    kStringMaxLength: K_STRING_MAX_LENGTH,
    constants: { MAX_LENGTH: K_MAX_LENGTH, MAX_STRING_LENGTH: K_STRING_MAX_LENGTH },
    isAscii,
    isUtf8,
    atob: globalThis.atob,
    btoa: globalThis.btoa,
    /* Node re-exports the WHATWG classes here since v18 (undici's
     * fetch/file.js extends buffer.Blob at LOAD). The web prelude
     * (scr_web.c) owns the implementations. */
    Blob: globalThis.Blob,
    File: globalThis.File,
    transcode: () => {
      throw new Error("buffer.transcode is not available in the scriptc island");
    },
    resolveObjectURL: () => undefined,
  };
}
    const mod = makeBuffer();
    mod.default = mod;
    return mod;
  });
