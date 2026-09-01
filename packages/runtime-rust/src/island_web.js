((global) => {
  class TextEncoder {
    get encoding() {
      return "utf-8";
    }

    encode(input) {
      const source = input === undefined ? "" : String(input);
      const bytes = [];
      for (let index = 0; index < source.length; index += 1) {
        let codePoint = source.charCodeAt(index);
        if (codePoint >= 0xd800 && codePoint <= 0xdbff) {
          const next = index + 1 < source.length ? source.charCodeAt(index + 1) : 0;
          if (next >= 0xdc00 && next <= 0xdfff) {
            codePoint = 0x10000 + ((codePoint - 0xd800) << 10) + (next - 0xdc00);
            index += 1;
          } else {
            codePoint = 0xfffd;
          }
        } else if (codePoint >= 0xdc00 && codePoint <= 0xdfff) {
          codePoint = 0xfffd;
        }

        if (codePoint <= 0x7f) bytes.push(codePoint);
        else if (codePoint <= 0x7ff) {
          bytes.push(0xc0 | (codePoint >> 6), 0x80 | (codePoint & 63));
        } else if (codePoint <= 0xffff) {
          bytes.push(
            0xe0 | (codePoint >> 12),
            0x80 | ((codePoint >> 6) & 63),
            0x80 | (codePoint & 63),
          );
        } else {
          bytes.push(
            0xf0 | (codePoint >> 18),
            0x80 | ((codePoint >> 12) & 63),
            0x80 | ((codePoint >> 6) & 63),
            0x80 | (codePoint & 63),
          );
        }
      }
      return new Uint8Array(bytes);
    }
  }

  class TextDecoder {
    constructor(label, options) {
      const normalized = String(label === undefined ? "utf-8" : label).trim().toLowerCase();
      if (normalized !== "utf-8" && normalized !== "utf8" && normalized !== "unicode-1-1-utf-8") {
        throw new RangeError(`the scriptc island's TextDecoder supports utf-8 only (got '${normalized}')`);
      }
      this._fatal = Boolean(options && options.fatal);
      this._ignoreBOM = Boolean(options && options.ignoreBOM);
      this._reset();
    }

    get encoding() {
      return "utf-8";
    }

    get fatal() {
      return this._fatal;
    }

    get ignoreBOM() {
      return this._ignoreBOM;
    }

    _clearSequence() {
      this._codePoint = 0;
      this._continuationsNeeded = 0;
      this._continuationsSeen = 0;
      this._nextByteLowerBound = 0x80;
      this._nextByteUpperBound = 0xbf;
    }

    _reset() {
      this._clearSequence();
      this._bomPending = !this._ignoreBOM;
    }

    decode(input, options) {
      const stream = Boolean(options && options.stream);
      let bytes;
      if (input === undefined) bytes = new Uint8Array(0);
      else if (input instanceof Uint8Array) bytes = input;
      else if (input instanceof ArrayBuffer) bytes = new Uint8Array(input);
      else if (ArrayBuffer.isView(input)) {
        bytes = new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
      } else {
        throw new TypeError("TextDecoder.decode takes an ArrayBuffer or ArrayBufferView");
      }

      const units = [];
      const fail = () => {
        if (this._fatal) {
          this._reset();
          throw new TypeError("The encoded data was not valid utf-8");
        }
        units.push(0xfffd);
      };
      const emit = (codePoint) => {
        if (codePoint <= 0xffff) units.push(codePoint);
        else {
          const astral = codePoint - 0x10000;
          units.push(0xd800 + (astral >> 10), 0xdc00 + (astral & 0x3ff));
        }
      };

      for (let index = 0; index < bytes.length; index += 1) {
        const byte = bytes[index];
        if (this._continuationsNeeded === 0) {
          if (byte <= 0x7f) {
            emit(byte);
            continue;
          }
          if (byte >= 0xc2 && byte <= 0xdf) {
            this._continuationsNeeded = 1;
            this._codePoint = byte & 0x1f;
          } else if (byte >= 0xe0 && byte <= 0xef) {
            if (byte === 0xe0) this._nextByteLowerBound = 0xa0;
            if (byte === 0xed) this._nextByteUpperBound = 0x9f;
            this._continuationsNeeded = 2;
            this._codePoint = byte & 0x0f;
          } else if (byte >= 0xf0 && byte <= 0xf4) {
            if (byte === 0xf0) this._nextByteLowerBound = 0x90;
            if (byte === 0xf4) this._nextByteUpperBound = 0x8f;
            this._continuationsNeeded = 3;
            this._codePoint = byte & 0x07;
          } else {
            fail();
          }
          continue;
        }

        if (byte < this._nextByteLowerBound || byte > this._nextByteUpperBound) {
          this._clearSequence();
          fail();
          index -= 1;
          continue;
        }
        this._nextByteLowerBound = 0x80;
        this._nextByteUpperBound = 0xbf;
        this._codePoint = (this._codePoint << 6) | (byte & 0x3f);
        this._continuationsSeen += 1;
        if (this._continuationsSeen === this._continuationsNeeded) {
          emit(this._codePoint);
          this._clearSequence();
        }
      }

      if (!stream && this._continuationsNeeded !== 0) {
        this._clearSequence();
        fail();
      }

      let start = 0;
      if (this._bomPending && units.length > 0) {
        this._bomPending = false;
        if (units[0] === 0xfeff) start = 1;
      }
      let decoded = "";
      for (let index = start; index < units.length; index += 4096) {
        decoded += String.fromCharCode.apply(null, units.slice(index, index + 4096));
      }
      if (!stream) this._reset();
      return decoded;
    }
  }

  const formSafe = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789*-._";
  const formEncode = (value) => {
    const bytes = new TextEncoder().encode(value);
    let encoded = "";
    for (let index = 0; index < bytes.length; index += 1) {
      const byte = bytes[index];
      const character = String.fromCharCode(byte);
      if (byte === 0x20) encoded += "+";
      else if (formSafe.indexOf(character) >= 0) encoded += character;
      else encoded += `%${byte < 16 ? "0" : ""}${byte.toString(16).toUpperCase()}`;
    }
    return encoded;
  };
  const formDecode = (value) => {
    const bytes = [];
    for (let index = 0; index < value.length; index += 1) {
      let character = value[index];
      if (character === "+") bytes.push(0x20);
      else if (
        character === "%" &&
        index + 2 < value.length &&
        /^[0-9a-fA-F]{2}$/.test(value.slice(index + 1, index + 3))
      ) {
        bytes.push(parseInt(value.slice(index + 1, index + 3), 16));
        index += 2;
      } else {
        const first = value.charCodeAt(index);
        const second = index + 1 < value.length ? value.charCodeAt(index + 1) : 0;
        if (first >= 0xd800 && first <= 0xdbff && second >= 0xdc00 && second <= 0xdfff) {
          character = value.slice(index, index + 2);
          index += 1;
        }
        const encoded = new TextEncoder().encode(character);
        for (let byte = 0; byte < encoded.length; byte += 1) bytes.push(encoded[byte]);
      }
    }
    return new TextDecoder().decode(new Uint8Array(bytes));
  };

  class URLSearchParams {
    constructor(init) {
      this._pairs = [];
      if (init === undefined || init === null) return;
      if (init instanceof URLSearchParams) {
        for (const [key, value] of init._pairs) this._pairs.push([key, value]);
        return;
      }
      if (typeof init === "string") {
        let source = init;
        if (source.startsWith("?")) source = source.slice(1);
        if (source === "") return;
        for (const part of source.split("&")) {
          if (part === "") continue;
          const separator = part.indexOf("=");
          if (separator < 0) this._pairs.push([formDecode(part), ""]);
          else {
            this._pairs.push([
              formDecode(part.slice(0, separator)),
              formDecode(part.slice(separator + 1)),
            ]);
          }
        }
        return;
      }
      if (typeof init === "object") {
        if (typeof init[Symbol.iterator] === "function") {
          for (const pair of init) {
            const values = [...pair];
            if (values.length !== 2) {
              throw new TypeError("URLSearchParams sequence init entries must be [name, value] pairs");
            }
            this._pairs.push([String(values[0]), String(values[1])]);
          }
        } else {
          for (const key of Object.keys(init)) this._pairs.push([String(key), String(init[key])]);
        }
        return;
      }
      throw new TypeError("unsupported URLSearchParams init");
    }

    get size() {
      return this._pairs.length;
    }

    append(name, value) {
      this._pairs.push([String(name), String(value)]);
    }

    delete(name, value) {
      const key = String(name);
      const hasValue = value !== undefined;
      const expected = hasValue ? String(value) : undefined;
      for (let index = 0; index < this._pairs.length; ) {
        const [pairKey, pairValue] = this._pairs[index];
        if (pairKey === key && (!hasValue || pairValue === expected)) this._pairs.splice(index, 1);
        else index += 1;
      }
    }

    get(name) {
      const key = String(name);
      for (const [pairKey, pairValue] of this._pairs) {
        if (pairKey === key) return pairValue;
      }
      return null;
    }

    getAll(name) {
      const key = String(name);
      const values = [];
      for (const [pairKey, pairValue] of this._pairs) {
        if (pairKey === key) values.push(pairValue);
      }
      return values;
    }

    has(name, value) {
      const key = String(name);
      const hasValue = value !== undefined;
      const expected = hasValue ? String(value) : undefined;
      for (const [pairKey, pairValue] of this._pairs) {
        if (pairKey === key && (!hasValue || pairValue === expected)) return true;
      }
      return false;
    }

    set(name, value) {
      const key = String(name);
      const replacement = String(value);
      let found = false;
      for (let index = 0; index < this._pairs.length; ) {
        if (this._pairs[index][0] !== key) {
          index += 1;
          continue;
        }
        if (!found) {
          this._pairs[index] = [key, replacement];
          found = true;
          index += 1;
        } else this._pairs.splice(index, 1);
      }
      if (!found) this._pairs.push([key, replacement]);
    }

    sort() {
      this._pairs.sort((left, right) => {
        if (left[0] < right[0]) return -1;
        if (left[0] > right[0]) return 1;
        return 0;
      });
    }

    toString() {
      return this._pairs
        .map(([key, value]) => `${formEncode(key)}=${formEncode(value)}`)
        .join("&");
    }

    forEach(callback, thisArg) {
      for (const [key, value] of this._pairs) callback.call(thisArg, value, key, this);
    }

    *entries() {
      for (const [key, value] of this._pairs) yield [key, value];
    }

    *keys() {
      for (const [key] of this._pairs) yield key;
    }

    *values() {
      for (const [, value] of this._pairs) yield value;
    }

    [Symbol.iterator]() {
      return this.entries();
    }
  }

  class DOMException extends Error {
    constructor(message = "", name = "Error") {
      super(String(message));
      this.name = String(name);
    }

    get code() {
      return this.name === "InvalidCharacterError" ? 5 : 0;
    }
  }

  const base64Alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  const invalidBase64 = () => new DOMException("Invalid character", "InvalidCharacterError");
  const btoa = (data) => {
    const source = String(data);
    let encoded = "";
    for (let index = 0; index < source.length; index += 3) {
      const first = source.charCodeAt(index);
      const second = index + 1 < source.length ? source.charCodeAt(index + 1) : Number.NaN;
      const third = index + 2 < source.length ? source.charCodeAt(index + 2) : Number.NaN;
      if (first > 0xff || second > 0xff || third > 0xff) throw invalidBase64();
      const value = (first << 16) | ((second || 0) << 8) | (third || 0);
      encoded += base64Alphabet[(value >> 18) & 63];
      encoded += base64Alphabet[(value >> 12) & 63];
      encoded += Number.isNaN(second) ? "=" : base64Alphabet[(value >> 6) & 63];
      encoded += Number.isNaN(third) ? "=" : base64Alphabet[value & 63];
    }
    return encoded;
  };
  const atob = (data) => {
    let source = String(data).replace(/[\t\n\f\r ]+/g, "");
    if (source.length % 4 === 0) source = source.replace(/={1,2}$/, "");
    if (source.length % 4 === 1) throw invalidBase64();
    let decoded = "";
    let buffer = 0;
    let bits = 0;
    for (let index = 0; index < source.length; index += 1) {
      const value = base64Alphabet.indexOf(source[index]);
      if (value < 0) throw invalidBase64();
      buffer = (buffer << 6) | value;
      bits += 6;
      if (bits >= 8) {
        bits -= 8;
        decoded += String.fromCharCode((buffer >> bits) & 0xff);
      }
    }
    return decoded;
  };

  global.TextEncoder = TextEncoder;
  global.TextDecoder = TextDecoder;
  global.URLSearchParams = URLSearchParams;
  global.DOMException = DOMException;
  global.btoa = btoa;
  global.atob = atob;
  /* queueMicrotask: the engine ships the job queue but not this spelling,
   * and the shared island bootstrap's process.nextTick and stream
   * scheduling are written against it. A resolved promise's reaction IS a
   * microtask, so ordering against other promise jobs is right; the one
   * divergence is a THROWING callback, which the spec reports as an
   * uncaught exception and this turns into an unhandled rejection. The
   * queue drains where the island runs jobs — after each island entry —
   * so a tick queued by the last statement of a program still runs. */
  if (global.queueMicrotask === undefined) {
    global.queueMicrotask = (callback) => { Promise.resolve().then(callback); };
  }
  const nativeConsoleLog = global.console.log;
  global.console.log = (...values) => nativeConsoleLog(...values.map((value) => String(value)));
})(globalThis);
