    /* node:crypto — the hashing/random slice over host bridges
     * (md5/sha1/sha256 digest + HMAC through the same C
     * implementations the static lowerings use; randomness through
     * the web prelude's CSPRNG), pbkdf2 over the HMAC bridge, and
     * honest throwing stubs for the key/cipher machinery the island
     * does not carry. Differentially tested against real Node. */
  builtins.crypto = memo(() => {
function makeCrypto(env) {
  const Buffer = env.Buffer;
  const webcrypto = globalThis.crypto;
  const toU8 = (data, enc, name) => {
    if (typeof data === "string") return Buffer.from(data, enc === undefined ? "utf8" : enc);
    if (data instanceof Uint8Array) return data;
    if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    if (data instanceof ArrayBuffer) return new Uint8Array(data);
    const e = new TypeError('The "' + name + '" argument must be of type string or an instance of Buffer, TypedArray, or DataView. Received ' + (data === null ? "null" : typeof data === "object" ? "an instance of " + ((data.constructor && data.constructor.name) || "Object") : typeof data === "undefined" ? "undefined" : "type " + typeof data + " (" + JSON.stringify(data) + ")"));
    e.code = "ERR_INVALID_ARG_TYPE";
    throw e;
  };
  const unsupportedDigest = () => {
    return new Error("Digest method not supported");
  };
  const concatChunks = (chunks) => {
    let total = 0;
    for (const c of chunks) total += c.length;
    const out = new Uint8Array(total);
    let o = 0;
    for (const c of chunks) {
      out.set(c, o);
      o += c.length;
    }
    return out;
  };
  class Hash {
    constructor(algorithm, from) {
      if (from === undefined) {
        const alg = String(algorithm).toLowerCase();
        if (env.digest(alg, new Uint8Array(0)) === undefined) throw unsupportedDigest();
        this._alg = alg;
        this._chunks = [];
      } else {
        this._alg = from._alg;
        this._chunks = from._chunks.slice();
      }
      this._done = false;
    }
    update(data, inputEncoding) {
      if (this._done) {
        const e = new Error("Digest already called");
        e.code = "ERR_CRYPTO_HASH_FINALIZED";
        throw e;
      }
      this._chunks.push(toU8(data, inputEncoding, "data"));
      return this;
    }
    copy() {
      return new Hash(this._alg, this);
    }
    digest(outputEncoding) {
      if (this._done) {
        const e = new Error("Digest already called");
        e.code = "ERR_CRYPTO_HASH_FINALIZED";
        throw e;
      }
      this._done = true;
      const raw = env.digest(this._alg, concatChunks(this._chunks));
      const buf = Buffer.from(raw.buffer, raw.byteOffset, raw.length);
      return outputEncoding === undefined || outputEncoding === "buffer" ? buf : buf.toString(outputEncoding);
    }
  }
  class Hmac {
    constructor(algorithm, key) {
      const alg = String(algorithm).toLowerCase();
      if (env.digest(alg, new Uint8Array(0)) === undefined) throw unsupportedDigest();
      this._alg = alg;
      this._key = toU8(key, "utf8", "key");
      this._chunks = [];
      this._done = false;
    }
    update(data, inputEncoding) {
      this._chunks.push(toU8(data, inputEncoding, "data"));
      return this;
    }
    digest(outputEncoding) {
      this._done = true;
      const raw = env.hmac(this._alg, this._key, concatChunks(this._chunks));
      const buf = Buffer.from(raw.buffer, raw.byteOffset, raw.length);
      return outputEncoding === undefined || outputEncoding === "buffer" ? buf : buf.toString(outputEncoding);
    }
  }
  const createHash = (algorithm) => new Hash(algorithm);
  const createHmac = (algorithm, key) => new Hmac(algorithm, key);
  const hash = (algorithm, data, outputEncoding) => {
    const h = new Hash(algorithm);
    h.update(typeof data === "string" ? Buffer.from(data, "utf8") : data);
    return h.digest(outputEncoding === undefined ? "hex" : outputEncoding);
  };
  const fillRandom = (u8) => {
    for (let i = 0; i < u8.length; i += 65536) {
      webcrypto.getRandomValues(u8.subarray(i, Math.min(i + 65536, u8.length)));
    }
    return u8;
  };
  const randomBytes = (size, callback) => {
    if (typeof size !== "number" || Number.isNaN(size) || size < 0) {
      const e = new RangeError('The value of "size" is out of range. It must be >= 0 && <= 2147483647. Received ' + size);
      e.code = "ERR_OUT_OF_RANGE";
      throw e;
    }
    const buf = fillRandom(Buffer.alloc(size));
    if (typeof callback === "function") {
      queueMicrotask(() => callback(null, buf));
      return undefined;
    }
    return buf;
  };
  const randomFillSync = (buf, offset, size) => {
    const off = offset === undefined ? 0 : offset;
    const n = size === undefined ? buf.byteLength - off : size;
    const u8 = buf instanceof Uint8Array ? buf : new Uint8Array(buf.buffer || buf);
    fillRandom(u8.subarray(off, off + n));
    return buf;
  };
  const randomFill = (buf, ...rest) => {
    const callback = rest.pop();
    if (typeof callback !== "function") {
      const e = new TypeError('The "callback" argument must be of type function. Received ' + (callback === undefined ? "undefined" : "type " + typeof callback));
      e.code = "ERR_INVALID_ARG_TYPE";
      throw e;
    }
    randomFillSync(buf, ...rest);
    queueMicrotask(() => callback(null, buf));
  };
  const randomInt = (min, max, callback) => {
    if (max === undefined || typeof max === "function") {
      callback = max;
      max = min;
      min = 0;
    }
    if (!Number.isSafeInteger(min)) {
      const e = new TypeError('The "min" argument must be a safe integer. Received ' + min);
      e.code = "ERR_INVALID_ARG_TYPE";
      throw e;
    }
    if (max <= min) {
      const e = new RangeError('The value of "max" is out of range. It must be greater than the value of "min" (' + min + "). Received " + max);
      e.code = "ERR_OUT_OF_RANGE";
      throw e;
    }
    const range = max - min;
    const draw = () => {
      const bytes = fillRandom(new Uint8Array(6));
      let v = 0;
      for (let i = 0; i < 6; i++) v = v * 256 + bytes[i];
      return v;
    };
    const limit = Math.floor(Math.pow(2, 48) / range) * range;
    let v = draw();
    while (v >= limit) v = draw();
    const result = min + (v % range);
    if (typeof callback === "function") {
      queueMicrotask(() => callback(null, result));
      return undefined;
    }
    return result;
  };
  const randomUUID = () => webcrypto.randomUUID();
  const timingSafeEqual = (a, b) => {
    const ua = toU8(a, undefined, "buf1");
    const ub = toU8(b, undefined, "buf2");
    if (ua.byteLength !== ub.byteLength) {
      const e = new RangeError("Input buffers must have the same byte length");
      e.code = "ERR_CRYPTO_TIMING_SAFE_EQUAL_LENGTH";
      throw e;
    }
    let diff = 0;
    for (let i = 0; i < ua.length; i++) diff |= ua[i] ^ ub[i];
    return diff === 0;
  };
  const pbkdf2Sync = (password, salt, iterations, keylen, digestAlg) => {
    const alg = String(digestAlg).toLowerCase();
    if (env.digest(alg, new Uint8Array(0)) === undefined) throw unsupportedDigest();
    const pw = toU8(password, undefined, "password");
    const st = toU8(salt, undefined, "salt");
    const hLen = env.digest(alg, new Uint8Array(0)).length;
    const blocks = Math.ceil(keylen / hLen);
    const dk = new Uint8Array(blocks * hLen);
    for (let i = 1; i <= blocks; i++) {
      const block = new Uint8Array(st.length + 4);
      block.set(st, 0);
      block[st.length] = (i >>> 24) & 0xff;
      block[st.length + 1] = (i >>> 16) & 0xff;
      block[st.length + 2] = (i >>> 8) & 0xff;
      block[st.length + 3] = i & 0xff;
      let u = env.hmac(alg, pw, block);
      const t = new Uint8Array(u);
      for (let j = 1; j < iterations; j++) {
        u = env.hmac(alg, pw, u);
        for (let k = 0; k < hLen; k++) t[k] ^= u[k];
      }
      dk.set(t, (i - 1) * hLen);
    }
    return Buffer.from(dk.buffer, 0, keylen);
  };
  const pbkdf2 = (password, salt, iterations, keylen, digestAlg, callback) => {
    if (typeof callback !== "function") {
      const e = new TypeError('The "callback" argument must be of type function. Received undefined');
      e.code = "ERR_INVALID_ARG_TYPE";
      throw e;
    }
    let derived;
    try {
      derived = pbkdf2Sync(password, salt, iterations, keylen, digestAlg);
    } catch (err) {
      queueMicrotask(() => callback(err));
      return;
    }
    queueMicrotask(() => callback(null, derived));
  };
  const die = (name) => function unsupported() {
    throw new Error("crypto." + name + " is not available in the scriptc island (the embedded runtime carries the hashing/random slice only)");
  };
  class KeyObject {
    constructor() {
      throw new Error("crypto.KeyObject is not available in the scriptc island (the embedded runtime carries the hashing/random slice only)");
    }
  }
  const constants = {
    RSA_PKCS1_PADDING: 1,
    RSA_NO_PADDING: 3,
    RSA_PKCS1_OAEP_PADDING: 4,
    RSA_PKCS1_PSS_PADDING: 6,
    RSA_PSS_SALTLEN_DIGEST: -1,
    RSA_PSS_SALTLEN_MAX_SIGN: -2,
    RSA_PSS_SALTLEN_AUTO: -2,
    defaultCoreCipherList: "TLS_AES_256_GCM_SHA384:TLS_CHACHA20_POLY1305_SHA256:TLS_AES_128_GCM_SHA256",
  };
  constants.defaultCipherList = constants.defaultCoreCipherList;
  const crypto = {
    createHash, createHmac, hash, Hash, Hmac,
    randomBytes, randomFillSync, randomFill, randomInt, randomUUID,
    getRandomValues: (ta) => webcrypto.getRandomValues(ta),
    timingSafeEqual, pbkdf2, pbkdf2Sync,
    getHashes: () => ["md5", "sha1", "sha256", "sha384", "sha512"],
    getCiphers: () => [],
    getCurves: () => [],
    webcrypto,
    constants,
    KeyObject,
    createCipheriv: die("createCipheriv"),
    createDecipheriv: die("createDecipheriv"),
    createSign: die("createSign"),
    createVerify: die("createVerify"),
    createDiffieHellman: die("createDiffieHellman"),
    createECDH: die("createECDH"),
    createPublicKey: die("createPublicKey"),
    createPrivateKey: die("createPrivateKey"),
    createSecretKey: die("createSecretKey"),
    diffieHellman: die("diffieHellman"),
    generateKeyPair: die("generateKeyPair"),
    generateKeyPairSync: die("generateKeyPairSync"),
    generateKey: die("generateKey"),
    generateKeySync: die("generateKeySync"),
    sign: die("sign"),
    verify: die("verify"),
    publicEncrypt: die("publicEncrypt"),
    publicDecrypt: die("publicDecrypt"),
    privateEncrypt: die("privateEncrypt"),
    privateDecrypt: die("privateDecrypt"),
    scrypt: die("scrypt"),
    scryptSync: die("scryptSync"),
    hkdf: die("hkdf"),
    hkdfSync: die("hkdfSync"),
    X509Certificate: die("X509Certificate"),
    Certificate: die("Certificate"),
    checkPrime: die("checkPrime"),
    checkPrimeSync: die("checkPrimeSync"),
    generatePrime: die("generatePrime"),
    generatePrimeSync: die("generatePrimeSync"),
    secureHeapUsed: die("secureHeapUsed"),
    setEngine: die("setEngine"),
    setFips: () => {},
    getFips: () => 0,
  };
  crypto.subtle = webcrypto ? webcrypto.subtle : undefined;
  return crypto;
}
    const mod = makeCrypto({ digest: (a, d) => host.digest(a, d), hmac: (a, k, d) => host.hmac(a, k, d), Buffer: builtins.buffer().Buffer });
    mod.default = mod;
    return mod;
  });
