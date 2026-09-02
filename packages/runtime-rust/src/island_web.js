/* The web-platform prelude, called from island_eval.rs with the same
 * `host` bridge the module bootstrap gets. It is an ARROW, not an IIFE,
 * so the host object can cross in — mirroring scr_island_web_boot on the
 * C lane, which evals its prelude to a function and calls it with a host. */
(host) => {
  const global = globalThis;
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

  class TextDecoderStream extends global.TransformStream {
    constructor(label, options) {
      const decoder = new TextDecoder(label, options);
      super({
        transform(chunk, controller) {
          const text = decoder.decode(chunk, { stream: true });
          if (text !== "") controller.enqueue(text);
        },
        flush(controller) {
          const text = decoder.decode();
          if (text !== "") controller.enqueue(text);
        },
      });
      this._decoder = decoder;
    }
    get encoding() { return this._decoder.encoding; }
    get fatal() { return this._decoder.fatal; }
    get ignoreBOM() { return this._decoder.ignoreBOM; }
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

    /* WebIDL pair-iterable iteration is LIVE: forEach and the
     * entries/keys/values iterators hold the params object plus a
     * positional index and re-read the CURRENT list on every step — they
     * do NOT snapshot. So a callback that appends is re-entered for the
     * new tail, a delete() mid-iteration makes the iterator skip forward
     * over the hole, and a sort() mid-iteration can re-yield a pair that
     * moved past the cursor. Oracle-pinned by corpus 1120 lines 32-35
     * against Node, and the exact twin of scr_web.c's copy. */
    forEach(callback, thisArg) {
      for (let index = 0; index < this._pairs.length; index += 1) {
        const [key, value] = this._pairs[index];
        callback.call(thisArg, value, key, this);
      }
    }

    _iterate(kind) {
      const params = this;
      let index = 0;
      const iterator = {
        next() {
          if (index >= params._pairs.length) return { value: undefined, done: true };
          const [key, value] = params._pairs[index];
          index += 1;
          return {
            value: kind === "key" ? key : kind === "value" ? value : [key, value],
            done: false,
          };
        },
        [Symbol.iterator]() {
          return iterator;
        },
      };
      return iterator;
    }

    entries() {
      return this._iterate("key+value");
    }

    keys() {
      return this._iterate("key");
    }

    values() {
      return this._iterate("value");
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
  global.TextDecoderStream = TextDecoderStream;
  global.URLSearchParams = URLSearchParams;
  global.DOMException = DOMException;
  global.btoa = btoa;
  global.atob = atob;

  class Headers {
    constructor(init) {
      this._pairs = [];
      if (init === undefined || init === null) return;
      if (init instanceof Headers) {
        this._pairs = init._pairs.map(([name, value]) => [name, value]);
      } else if (typeof init[Symbol.iterator] === "function") {
        for (const pair of init) this.append(pair[0], pair[1]);
      } else {
        for (const name of Object.keys(init)) this.append(name, init[name]);
      }
    }
    append(name, value) {
      this._pairs.push([String(name).toLowerCase(), String(value).trim()]);
    }
    get(name) {
      const key = String(name).toLowerCase();
      const values = this._pairs.filter(([entry]) => entry === key).map(([, value]) => value);
      return values.length === 0 ? null : values.join(", ");
    }
    has(name) {
      const key = String(name).toLowerCase();
      return this._pairs.some(([entry]) => entry === key);
    }
    getSetCookie() {
      return this._pairs
        .filter(([name]) => name === "set-cookie")
        .map(([, value]) => value);
    }
    set(name, value) {
      const key = String(name).toLowerCase();
      this.delete(key);
      this.append(key, value);
    }
    delete(name) {
      const key = String(name).toLowerCase();
      this._pairs = this._pairs.filter(([entry]) => entry !== key);
    }
    _sortedPairs() {
      return this._pairs.slice().sort(([left], [right]) =>
        left < right ? -1 : left > right ? 1 : 0);
    }
    entries() {
      return this._sortedPairs()[Symbol.iterator]();
    }
    keys() { return this._pairs.map(([name]) => name)[Symbol.iterator](); }
    values() { return this._pairs.map(([, value]) => value)[Symbol.iterator](); }
    forEach(callback, thisArg) {
      for (const [name, value] of this._sortedPairs()) callback.call(thisArg, value, name, this);
    }
    [Symbol.iterator]() { return this.entries(); }
    _flat() { return this._pairs.flat(); }
  }

  const consumeBody = async (response) => {
    if (response.bodyUsed) {
      throw new TypeError("Body is unusable: Body has already been read");
    }
    response.bodyUsed = true;
    const body = response._body;
    if (body === null) return new Uint8Array(0);
    if (body instanceof Uint8Array) return body;
    const reader = body.getReader();
    const chunks = [];
    let length = 0;
    for (;;) {
      const result = await reader.read();
      if (result.done) break;
      const chunk = typeof result.value === "string"
        ? new TextEncoder().encode(result.value)
        : result.value;
      if (!(chunk instanceof Uint8Array)) {
        throw new TypeError("body stream produced a non-byte chunk");
      }
      chunks.push(chunk);
      length += chunk.length;
    }
    const bytes = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.length;
    }
    return bytes;
  };

  class Request {
    constructor(input, init = {}) {
      const source = input instanceof Request ? input : null;
      this.url = source === null ? String(input) : source.url;
      this.method = String(init.method === undefined
        ? source === null ? "GET" : source.method
        : init.method).toUpperCase();
      this.headers = new Headers(init.headers === undefined
        ? source === null ? undefined : source.headers
        : init.headers);
      this._body = init.body === undefined
        ? source === null ? undefined : source._body
        : init.body;
    }
  }

  class Response {
    constructor(body = null, init = {}) {
      this.status = init.status === undefined ? 200 : Number(init.status);
      this.statusText = init.statusText === undefined ? "" : String(init.statusText);
      this.headers = new Headers(init.headers);
      this.url = init.url === undefined ? "" : String(init.url);
      this.redirected = Boolean(init.redirected);
      this.type = "default";
      this.bodyUsed = false;
      this._body = body === null
        ? null
        : body instanceof Uint8Array
          ? body
          : new TextEncoder().encode(String(body));
    }
    get ok() { return this.status >= 200 && this.status <= 299; }
    get body() {
      if (this._body === null) return null;
      if (this._body instanceof Uint8Array) {
        const bytes = this._body;
        this._body = new global.ReadableStream({
          start(controller) {
            controller.enqueue(bytes);
            controller.close();
          },
        });
      }
      return this._body;
    }
    async bytes() {
      return consumeBody(this);
    }
    async arrayBuffer() {
      const bytes = await this.bytes();
      return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    }
    async text() { return new TextDecoder().decode(await this.bytes()); }
    async json() { return JSON.parse(await this.text()); }
    clone() {
      if (this.bodyUsed) throw new TypeError("Response.clone: Body has already been consumed.");
      if (!(this._body instanceof Uint8Array) && this._body !== null) {
        throw new Error("Response.clone is not supported for a streamed body in the scriptc island");
      }
      return new Response(new Uint8Array(this._body), {
        status: this.status,
        statusText: this.statusText,
        headers: this.headers,
        url: this.url,
        redirected: this.redirected,
      });
    }
    static _native(row, redirected = false) {
      const headers = [];
      for (let index = 0; index < row[3].length; index += 2) {
        headers.push([row[3][index], row[3][index + 1]]);
      }
      const responseHeaders = new Headers(headers);
      const encoding = responseHeaders.get("content-encoding");
      let body = row[4];
      if (encoding === "gzip" || encoding === "x-gzip") {
        body = host.zlib(0, body, 2, 0);
      } else if (encoding === "deflate") {
        body = host.zlib(0, body, 0, 0);
      }
      return new Response(body, {
        status: row[0],
        statusText: row[1],
        url: row[2],
        headers: responseHeaders,
        redirected,
      });
    }
  }

  const fetchBody = (body, headers) => {
    if (body === undefined || body === null) return new Uint8Array(0);
    if (body instanceof Uint8Array) return body;
    if (body instanceof ArrayBuffer) return new Uint8Array(body);
    if (ArrayBuffer.isView(body)) {
      return new Uint8Array(body.buffer, body.byteOffset, body.byteLength);
    }
    if (body instanceof URLSearchParams) {
      if (!headers.has("content-type")) {
        headers.set("content-type", "application/x-www-form-urlencoded;charset=UTF-8");
      }
      return new TextEncoder().encode(String(body));
    }
    if (typeof body === "string") {
      if (!headers.has("content-type")) headers.set("content-type", "text/plain;charset=UTF-8");
      return new TextEncoder().encode(body);
    }
    if (body instanceof global.ReadableStream) {
      if (!headers.has("content-length") && !headers.has("transfer-encoding")) {
        headers.set("transfer-encoding", "chunked");
      }
      return (async () => {
        const reader = body.getReader();
        const chunks = [];
        let length = 0;
        for (;;) {
          const result = await reader.read();
          if (result.done) break;
          const chunk = typeof result.value === "string"
            ? new TextEncoder().encode(result.value)
            : result.value;
          if (!(chunk instanceof Uint8Array)) {
            throw new TypeError("body stream produced a non-byte chunk");
          }
          chunks.push(chunk);
          length += chunk.length;
        }
        const bytes = new Uint8Array(length);
        let offset = 0;
        for (const chunk of chunks) {
          bytes.set(chunk, offset);
          offset += chunk.length;
        }
        return bytes;
      })();
    }
    throw new TypeError("fetch body is outside the supported byte/string subset");
  };
  global.Headers = Headers;
  global.Request = Request;
  global.Response = Response;
  global.fetch = function fetch(input, init = {}) {
    const source = input instanceof Request ? input : null;
    const url = source === null ? String(input) : source.url;
    const method = String(init.method === undefined
      ? source === null ? "GET" : source.method
      : init.method).toUpperCase();
    const headers = new Headers(init.headers === undefined
      ? source === null ? undefined : source.headers
      : init.headers);
    if (!headers.has("connection")) headers.set("connection", "close");
    const body = fetchBody(init.body === undefined
      ? source === null ? undefined : source._body
      : init.body, headers);
    const redirect = init.redirect === undefined ? "follow" : String(init.redirect);
    if (redirect !== "follow" && redirect !== "error" && redirect !== "manual") {
      throw new TypeError(`undefined: ${redirect} is not an accepted type. Expected one of follow, manual, error.`);
    }
    const send = (bytes) => {
      const hop = (hopUrl, hopMethod, hopHeaders, hopBody, count, redirected) =>
        host.fetch(hopUrl, hopMethod, hopHeaders._flat(), hopBody).then((row) => {
          const response = Response._native(row, redirected);
          const location = response.headers.get("location");
          const redirectStatus = response.status === 301 || response.status === 302 ||
            response.status === 303 || response.status === 307 || response.status === 308;
          if (!redirectStatus || location === null || redirect === "manual") return response;
          if (redirect === "error" || count >= 20) {
            throw new TypeError("fetch failed");
          }
          const nextUrl = host.urlResolve(hopUrl, location);
          let nextMethod = hopMethod;
          let nextBody = hopBody;
          const nextHeaders = new Headers(hopHeaders);
          if (response.status === 303 ||
              ((response.status === 301 || response.status === 302) && hopMethod === "POST")) {
            nextMethod = "GET";
            nextBody = new Uint8Array(0);
            nextHeaders.delete("content-length");
            nextHeaders.delete("transfer-encoding");
            nextHeaders.delete("content-type");
          }
          return hop(nextUrl, nextMethod, nextHeaders, nextBody, count + 1, true);
        });
      return hop(url, method, headers, bytes, 0, false);
    };
    const request = body instanceof Promise ? body.then(send) : send(body);
    return request.catch((cause) => {
      if (cause instanceof TypeError && cause.message === "fetch failed") throw cause;
      const error = new TypeError("fetch failed");
      error.cause = cause;
      throw error;
    });
  };
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
  /* globalThis.crypto: the WebCrypto slice node:crypto's shim routes its
   * randomness through (12-crypto.js reads globalThis.crypto once, at
   * shim-factory time, so this must exist before the module bootstrap).
   * The validation — integer-TypedArray kind, the 65536-byte quota, and
   * the DOMException names Node reports — lives HERE, matching the C
   * island's web prelude text; only the fill itself differs, because Boa
   * cannot write a caller's view in place: host.random hands back bytes
   * this copies over the target through a view of the same buffer.
   * No `subtle`: the shim already answers `undefined` for it. */
  const integerTypedArrays = [
    "Int8Array", "Uint8Array", "Uint8ClampedArray", "Int16Array", "Uint16Array",
    "Int32Array", "Uint32Array", "BigInt64Array", "BigUint64Array",
  ];
  global.crypto = {
    getRandomValues(view) {
      const tag = view === null || typeof view !== "object"
        ? ""
        : Object.prototype.toString.call(view).slice(8, -1);
      if (integerTypedArrays.indexOf(tag) < 0) {
        const error = new TypeError("crypto.getRandomValues takes an integer TypedArray");
        error.name = "TypeMismatchError";
        throw error;
      }
      if (view.byteLength > 65536) {
        const error = new Error("The requested length exceeds 65,536 bytes");
        error.name = "QuotaExceededError";
        throw error;
      }
      if (view.byteLength > 0) {
        const target = new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
        target.set(host.random(view.byteLength));
      }
      return view;
    },
    randomUUID() {
      return host.uuid();
    },
  };

  /* Timers: Node's setTimeout/clearTimeout/setInterval/clearInterval for
   * embedded code, bridged onto the SHARED native timer heap
   * (host.setTimer/host.clearTimer) — REF'd like Node's (an armed timer
   * keeps the process alive), FIFO-ordered against static timers on one
   * heap. Returns a Timeout-shaped object (ref/unref/refresh/close,
   * numeric via toPrimitive) that clearTimeout/clearInterval accept
   * alongside plain ids. ref/unref update native event-loop liveness. */
  class Timeout {
    constructor(fn, delay, repeat) {
      this._fn = fn;
      this._delay = delay;
      this._repeat = repeat;
      this._id = host.setTimer(fn, delay, repeat);
      this._refed = true;
    }
    ref() { this._refed = true; host.setTimerRef(this._id, true); return this; }
    unref() { this._refed = false; host.setTimerRef(this._id, false); return this; }
    hasRef() { return host.timerHasRef(this._id); }
    refresh() {
      host.clearTimer(this._id);
      this._id = host.setTimer(this._fn, this._delay, this._repeat);
      if (!this._refed) host.setTimerRef(this._id, false);
      return this;
    }
    close() { host.clearTimer(this._id); return this; }
    [Symbol.toPrimitive]() { return this._id; }
  }
  const mkTimer = (fn, ms, args, repeat) => {
    if (typeof fn !== "function") {
      throw new TypeError(
        'The "callback" argument must be of type function. Received type ' + typeof fn,
      );
    }
    const cb = args.length === 0 ? fn : () => fn(...args);
    return new Timeout(cb, Number(ms), repeat);
  };
  global.setTimeout = (fn, ms, ...args) => mkTimer(fn, ms, args, false);
  global.setInterval = (fn, ms, ...args) => mkTimer(fn, ms, args, true);
  global.clearTimeout = (t) => {
    if (t === undefined || t === null) return;
    const id = typeof t === "number" ? t : Number(t);
    if (Number.isFinite(id)) host.clearTimer(id);
  };
  global.clearInterval = global.clearTimeout;
  const nativeConsoleLog = global.console.log;
  global.console.log = (...values) => nativeConsoleLog(...values.map((value) => String(value)));
}
