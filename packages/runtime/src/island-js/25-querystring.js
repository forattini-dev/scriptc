    /* node:querystring — Node's parse/stringify semantics ('+' is a
     * space on parse, %20 on stringify, arrays expand, null-proto
     * results), differentially tested. */
  builtins.querystring = memo(() => {
function makeQuerystring() {
  const unescapeBuffer = (s) => {
    try {
      return decodeURIComponent(s);
    } catch (e) {
      const bytes = [];
      for (let i = 0; i < s.length; i++) {
        if (s[i] === "%" && /^[0-9a-fA-F]{2}$/.test(s.slice(i + 1, i + 3))) {
          bytes.push(parseInt(s.slice(i + 1, i + 3), 16));
          i += 2;
        } else {
          const enc = new TextEncoder().encode(s[i]);
          for (const b of enc) bytes.push(b);
        }
      }
      return new TextDecoder().decode(new Uint8Array(bytes));
    }
  };
  const qsUnescape = (s) => unescapeBuffer(String(s));
  const hexTable = [];
  for (let i = 0; i < 256; i++) hexTable[i] = "%" + i.toString(16).toUpperCase().padStart(2, "0");
  const noEscape = new Set(
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._!'()*~".split(""),
  );
  const qsEscape = (str) => {
    const s = String(str);
    let out = "";
    for (const ch of s) {
      if (noEscape.has(ch)) {
        out += ch;
        continue;
      }
      const cp = ch.codePointAt(0);
      if (cp < 0x80) {
        out += hexTable[cp];
      } else if (cp < 0x800) {
        out += hexTable[0xc0 | (cp >> 6)] + hexTable[0x80 | (cp & 0x3f)];
      } else if (cp < 0x10000) {
        out += hexTable[0xe0 | (cp >> 12)] + hexTable[0x80 | ((cp >> 6) & 0x3f)] + hexTable[0x80 | (cp & 0x3f)];
      } else {
        out += hexTable[0xf0 | (cp >> 18)] + hexTable[0x80 | ((cp >> 12) & 0x3f)] + hexTable[0x80 | ((cp >> 6) & 0x3f)] + hexTable[0x80 | (cp & 0x3f)];
      }
    }
    return out;
  };
  const stringifyPrimitive = (v) => {
    if (typeof v === "string") return v;
    if (typeof v === "number" && Number.isFinite(v)) return String(v);
    if (typeof v === "bigint") return String(v);
    if (typeof v === "boolean") return v ? "true" : "false";
    return "";
  };
  const stringify = (obj, sep, eq, options) => {
    sep = sep || "&";
    eq = eq || "=";
    let escape = qsEscape;
    if (options !== undefined && options !== null && typeof options.encodeURIComponent === "function") {
      escape = options.encodeURIComponent;
    }
    if (obj === null || typeof obj !== "object") return "";
    const parts = [];
    for (const k of Object.keys(obj)) {
      const v = obj[k];
      const ek = escape(stringifyPrimitive(k));
      if (Array.isArray(v)) {
        for (const item of v) parts.push(ek + eq + escape(stringifyPrimitive(item)));
      } else {
        parts.push(ek + eq + escape(stringifyPrimitive(v)));
      }
    }
    return parts.join(sep);
  };
  const parse = (qs, sep, eq, options) => {
    sep = sep || "&";
    eq = eq || "=";
    const obj = Object.create(null);
    if (typeof qs !== "string" || qs.length === 0) return obj;
    let decode = qsUnescape;
    let maxKeys = 1000;
    if (options !== undefined && options !== null) {
      if (typeof options.decodeURIComponent === "function") decode = options.decodeURIComponent;
      if (typeof options.maxKeys === "number") maxKeys = options.maxKeys;
    }
    let pairs = qs.split(sep);
    if (maxKeys > 0) pairs = pairs.slice(0, maxKeys);
    for (const pair of pairs) {
      if (pair.length === 0) continue;
      const eqAt = pair.indexOf(eq);
      let k;
      let v;
      if (eqAt < 0) {
        k = decode(pair.split("+").join(" "));
        v = "";
      } else {
        k = decode(pair.slice(0, eqAt).split("+").join(" "));
        v = decode(pair.slice(eqAt + eq.length).split("+").join(" "));
      }
      if (k in obj) {
        if (Array.isArray(obj[k])) obj[k].push(v);
        else obj[k] = [obj[k], v];
      } else {
        obj[k] = v;
      }
    }
    return obj;
  };
  return {
    parse,
    stringify,
    decode: parse,
    encode: stringify,
    escape: qsEscape,
    unescape: qsUnescape,
    unescapeBuffer,
  };
}
    const q = makeQuerystring();
    q.default = q;
    return q;
  });
