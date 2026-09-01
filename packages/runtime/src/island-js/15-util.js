    /* node:util — the full JS shim, developed standalone and
     * differentially tested against real Node (inspect, format,
     * promisify, callbackify, inherits, deprecate, debuglog, types,
     * isDeepStrictEqual, stripVTControlCharacters, styleText,
     * parseArgs, toUSVString). The host supplies what JS cannot see:
     * promise state (JS_PromiseState), the pid, and fd writes. */
  builtins.util = memo(() => {
function makeUtil(env) {
  const inspectCustom = Symbol.for("nodejs.util.inspect.custom");
  const idRe = /^[a-zA-Z_][a-zA-Z_0-9]*$/; /* Node's keyStrRegExp: no $ */
  const strEsc = (s, q) => {
    let out = "";
    for (let i = 0; i < s.length; i++) {
      const c = s.charCodeAt(i);
      const ch = s[i];
      if (ch === q || ch === "\\") out += "\\" + ch;
      else if (c === 10) out += "\\n";
      else if (c === 9) out += "\\t";
      else if (c === 13) out += "\\r";
      else if (c === 8) out += "\\b";
      else if (c === 12) out += "\\f";
      else if (c === 11) out += "\\v";
      else if (c < 32 || c === 127) out += "\\x" + c.toString(16).toUpperCase().padStart(2, "0");
      else out += ch;
    }
    return out;
  };
  const quoteStr = (s) => {
    if (!s.includes("'")) return "'" + strEsc(s, "'") + "'";
    if (!s.includes('"')) return '"' + strEsc(s, '"') + '"';
    if (!s.includes("`") && !s.includes("${")) return "`" + strEsc(s, "`") + "`";
    return "'" + strEsc(s, "'") + "'";
  };
  const fmtNumber = (n) => (Object.is(n, -0) ? "-0" : String(n));
  const fmtBigInt = (n) => String(n) + "n";
  const fmtPrimitive = (ctx, v) => {
    const t = typeof v;
    if (t === "string") {
      if (v.length > ctx.maxStringLength) {
        const rest = v.length - ctx.maxStringLength;
        return quoteStr(v.slice(0, ctx.maxStringLength)) +
          "... " + rest + " more character" + (rest > 1 ? "s" : "");
      }
      return quoteStr(v);
    }
    if (t === "number") return fmtNumber(v);
    if (t === "bigint") return fmtBigInt(v);
    if (t === "boolean") return v ? "true" : "false";
    if (t === "undefined") return "undefined";
    return String(v); /* symbol */
  };
  const constructorNameOf = (v) => {
    let p = v;
    while (p !== null) {
      const d = Object.getOwnPropertyDescriptor(p, "constructor");
      if (d !== undefined && typeof d.value === "function" && d.value.name !== "") {
        return d.value.name;
      }
      p = Object.getPrototypeOf(p);
    }
    return null;
  };
  const fnBase = (v) => {
    const s = Function.prototype.toString.call(v);
    let kind = "Function";
    if (s.startsWith("class")) {
      let base = "class " + (v.name || "(anonymous)");
      const proto = Object.getPrototypeOf(v);
      if (typeof proto === "function" && proto.name !== "") base += " extends " + proto.name;
      return "[" + base + "]";
    }
    if (s.startsWith("async function") || (s.startsWith("async") && !s.startsWith("async function*"))) kind = "AsyncFunction";
    if (s.startsWith("function*") || /^async function\*/.test(s)) kind = s.startsWith("async") ? "AsyncGeneratorFunction" : "GeneratorFunction";
    if (/^async\s*(\*|function\*)/.test(s)) kind = "AsyncGeneratorFunction";
    return v.name === "" ? "[" + kind + " (anonymous)]" : "[" + kind + ": " + v.name + "]";
  };
  const kindTA = (v) => {
    const tag = Object.prototype.toString.call(v).slice(8, -1);
    return /^(Ui|I|Fl|Big)/.test(tag) && tag.endsWith("Array") ? tag : null;
  };
  const keyOf = (k) => {
    if (typeof k === "symbol") return String(k);
    return idRe.test(k) ? k : quoteStr(k);
  };
  const ownKeysOf = (ctx, v) => {
    const keys = [];
    for (const k of Object.keys(v)) keys.push(k);
    for (const s of Object.getOwnPropertySymbols(v)) {
      const d = Object.getOwnPropertyDescriptor(v, s);
      if (d && d.enumerable) keys.push(s);
    }
    return keys;
  };
  const fmtProperty = (ctx, v, k, depth) => {
    const d = Object.getOwnPropertyDescriptor(v, k) ||
      { value: v[k], enumerable: true };
    let val;
    if (d.value !== undefined || ("value" in d)) {
      val = fmtValue(ctx, d.value, depth + 1);
    } else if (d.get !== undefined) {
      val = d.set !== undefined ? "[Getter/Setter]" : "[Getter]";
    } else if (d.set !== undefined) {
      val = "[Setter]";
    } else {
      val = "undefined";
    }
    return keyOf(k) + ": " + val;
  };
  const belowBreakLength = (ctx, output, start, base) => {
    let total = output.length + start;
    if (total + output.length > ctx.breakLength) return false;
    for (let i = 0; i < output.length; i++) total += output[i].length;
    return total <= ctx.breakLength && base.length + total <= ctx.breakLength;
  };
  const groupArrayElements = (ctx, output, value) => {
    let totalLength = 0;
    let maxLength = 0;
    let i = 0;
    let outputLength = output.length;
    if (ctx.maxArrayLength < output.length) outputLength = output.length - 1;
    const dataLen = new Array(outputLength);
    for (; i < outputLength; i++) {
      const len = output[i].length;
      dataLen[i] = len;
      totalLength += len + 2;
      if (maxLength < len) maxLength = len;
    }
    const actualMax = maxLength + 2;
    if (actualMax * 3 + ctx.indentationLvl < ctx.breakLength &&
        (totalLength / actualMax > 5 || maxLength <= 6)) {
      const approxCharHeights = 2.5;
      const averageBias = Math.sqrt(actualMax - totalLength / output.length);
      const biasedMax = Math.max(actualMax - 3 - averageBias, 1);
      const columns = Math.min(
        Math.round(Math.sqrt(approxCharHeights * biasedMax * outputLength) / biasedMax),
        Math.floor((ctx.breakLength - ctx.indentationLvl) / actualMax),
        ctx.compact * 4,
        15,
      );
      if (columns <= 1) return output;
      const tmp = [];
      const maxLineLength = [];
      for (let ii = 0; ii < columns; ii++) {
        let lineLength = 0;
        for (let j = ii; j < output.length; j += columns) {
          if (dataLen[j] > lineLength) lineLength = dataLen[j];
        }
        maxLineLength[ii] = lineLength + 2;
      }
      let order = String.prototype.padStart;
      if (value !== undefined) {
        for (let ii = 0; ii < output.length; ii++) {
          if (typeof value[ii] !== "number" && typeof value[ii] !== "bigint") {
            order = String.prototype.padEnd;
            break;
          }
        }
      }
      for (let ii = 0; ii < outputLength; ii += columns) {
        const max = Math.min(ii + columns, outputLength);
        let str = "";
        let j = ii;
        for (; j < max - 1; j++) {
          const padding = maxLineLength[j - ii] + output[j].length - dataLen[j];
          str += order.call(output[j] + ", ", padding, " ");
        }
        if (order === String.prototype.padStart) {
          const padding = maxLineLength[j - ii] + output[j].length - dataLen[j] - 2;
          str += output[j].padStart(padding, " ");
        } else {
          str += output[j];
        }
        tmp.push(str);
      }
      if (ctx.maxArrayLength < output.length) tmp.push(output[outputLength]);
      output = tmp;
    }
    return output;
  };
  const reduceToSingleString = (ctx, output, base, braces, isArrayLike, depth, value) => {
    if (ctx.compact >= 1 && typeof ctx.compact === "number") {
      const entries = output.length;
      if (isArrayLike && entries > 6) output = groupArrayElements(ctx, output, value);
      if (ctx.currentDepth - depth < ctx.compact && entries === output.length) {
        const start = output.length + ctx.indentationLvl + braces[0].length + base.length + 10;
        if (belowBreakLength(ctx, output, start, base)) {
          const joined = output.join(", ");
          if (!joined.includes("\n")) {
            return (base ? base + " " : "") + braces[0] + " " + joined + " " + braces[1];
          }
        }
      }
    }
    const indentation = "\n" + " ".repeat(ctx.indentationLvl);
    return (base ? base + " " : "") + braces[0] + indentation + "  " +
      output.join("," + indentation + "  ") + indentation + braces[1];
  };
  const fmtList = (ctx, v, depth) => {
    const output = [];
    const max = Math.min(ctx.maxArrayLength, v.length);
    let i = 0;
    while (i < max) {
      if (!Object.prototype.hasOwnProperty.call(v, i)) {
        let j = i;
        while (j < v.length && !Object.prototype.hasOwnProperty.call(v, j)) j++;
        const n = Math.min(j, max) === j ? j - i : j - i;
        output.push("<" + n + " empty item" + (n > 1 ? "s" : "") + ">");
        i = j;
        continue;
      }
      output.push(fmtValue(ctx, v[i], depth + 1));
      i++;
    }
    if (v.length > max) {
      const rest = v.length - max;
      output.push("... " + rest + " more item" + (rest > 1 ? "s" : ""));
    }
    return output;
  };
  const fmtTypedArray = (ctx, v, depth) => {
    const max = Math.min(ctx.maxArrayLength, v.length);
    const output = new Array(max);
    for (let i = 0; i < max; i++) {
      output[i] = typeof v[i] === "bigint" ? fmtBigInt(v[i]) : fmtNumber(v[i]);
    }
    if (v.length > max) {
      const rest = v.length - max;
      output.push("... " + rest + " more item" + (rest > 1 ? "s" : ""));
    }
    return output;
  };
  const hexSlice = (u8, n) => {
    let s = "";
    for (let i = 0; i < n; i++) s += (i ? " " : "") + u8[i].toString(16).padStart(2, "0");
    return s;
  };
  const fmtValue = (ctx, value, depth, typedArray) => {
    if (typeof value !== "object" && typeof value !== "function") {
      return fmtPrimitive(ctx, value);
    }
    if (value === null) return "null";
    if (ctx.customInspect) {
      const maybe = value[inspectCustom];
      if (typeof maybe === "function" && maybe !== inspect &&
          !(value.constructor && value.constructor.prototype === value)) {
        const depthRemaining = ctx.depth === null ? null : ctx.depth - depth;
        const opts = {
          depth: ctx.depth, colors: ctx.colors, showHidden: ctx.showHidden,
          breakLength: ctx.breakLength, compact: ctx.compact,
          maxArrayLength: ctx.maxArrayLength, maxStringLength: ctx.maxStringLength,
          customInspect: ctx.customInspect, sorted: ctx.sorted, getters: ctx.getters,
          numericSeparator: ctx.numericSeparator, stylize: (s) => s,
        };
        const ret = maybe.call(value, depthRemaining, opts, inspect);
        if (ret !== value) {
          return typeof ret !== "string" ? fmtValue(ctx, ret, depth) : ret;
        }
      }
    }
    if (ctx.seen.includes(value)) {
      let index = 1;
      if (ctx.circular === undefined) {
        ctx.circular = new Map();
        ctx.circular.set(value, index);
      } else {
        const seenIndex = ctx.circular.get(value);
        if (seenIndex === undefined) {
          index = ctx.circular.size + 1;
          ctx.circular.set(value, index);
        } else {
          index = seenIndex;
        }
      }
      return "[Circular *" + index + "]";
    }
    return fmtRaw(ctx, value, depth, typedArray);
  };
  const fmtRaw = (ctx, value, depth, typedArray) => {
    let keys = ownKeysOf(ctx, value);
    const protoOf = Object.getPrototypeOf(value);
    const ctorName = protoOf === null ? null : constructorNameOf(value);
    let base = "";
    let braces;
    let formatter = null;
    let isArrayLike = false;
    const taKind = kindTA(value);
    if (Array.isArray(value)) {
      if (depth > ctx.depth && ctx.depth !== null) return "[Array]";
      const prefix = ctorName !== "Array" || protoOf === null
        ? (ctorName === null ? "[Array(" + value.length + "): null prototype] " : ctorName + "(" + value.length + ") ")
        : "";
      keys = keys.filter((k) => !(typeof k === "string" && /^\d+$/.test(k) && +k < value.length));
      braces = [prefix + "[", "]"];
      if (value.length === 0 && keys.length === 0) return braces[0] + "]";
      formatter = fmtList;
      isArrayLike = true;
    } else if (value instanceof Map) {
      if (depth > ctx.depth && ctx.depth !== null) return "[Map]";
      const size = value.size;
      const prefix = (ctorName !== "Map" ? ctorName + " [Map]" : "Map") + "(" + size + ") ";
      if (size === 0 && keys.length === 0) return prefix + "{}";
      braces = [prefix + "{", "}"];
      formatter = (c, v, d) => {
        const out = [];
        for (const [k, val] of v) {
          out.push(fmtValue(c, k, d + 1) + " => " + fmtValue(c, val, d + 1));
        }
        return out;
      };
    } else if (value instanceof Set) {
      if (depth > ctx.depth && ctx.depth !== null) return "[Set]";
      const size = value.size;
      const prefix = (ctorName !== "Set" ? ctorName + " [Set]" : "Set") + "(" + size + ") ";
      if (size === 0 && keys.length === 0) return prefix + "{}";
      braces = [prefix + "{", "}"];
      formatter = (c, v, d) => {
        const out = [];
        for (const val of v) out.push(fmtValue(c, val, d + 1));
        return out;
      };
    } else if (taKind !== null) {
      if (depth > ctx.depth && ctx.depth !== null) return "[" + taKind + "]";
      const prefix = (ctorName !== taKind && ctorName !== null ? ctorName + "(" + value.length + ") [" + taKind + "] " : taKind + "(" + value.length + ") ");
      braces = [prefix + "[", "]"];
      if (value.length === 0 && keys.length === 0) return braces[0] + "]";
      keys = keys.filter((k) => !(typeof k === "string" && /^\d+$/.test(k) && +k < value.length));
      formatter = fmtTypedArray;
      isArrayLike = true;
    } else if (typeof value === "function") {
      base = fnBase(value);
      if (keys.length === 0) return base;
      if (depth > ctx.depth && ctx.depth !== null) return base;
      braces = ["{", "}"];
      formatter = () => [];
    } else if (value instanceof RegExp) {
      base = RegExp.prototype.toString.call(value);
      if (keys.length === 0) return base;
      if (depth > ctx.depth && ctx.depth !== null) return base;
      braces = ["{", "}"];
      formatter = () => [];
    } else if (value instanceof Date) {
      const t = Date.prototype.getTime.call(value);
      base = Number.isNaN(t) ? "Invalid Date" : Date.prototype.toISOString.call(value);
      if (keys.length === 0) return base;
      if (depth > ctx.depth && ctx.depth !== null) return base;
      braces = ["{", "}"];
      formatter = () => [];
    } else if (value instanceof Error) {
      base = value.stack;
      if (typeof base !== "string" || base === "") {
        const name = value.name === undefined ? "Error" : String(value.name);
        const msg = value.message === undefined || value.message === "" ? "" : ": " + String(value.message);
        base = "[" + name + msg + "]";
      }
      keys = keys.filter((k) => k !== "message" && k !== "stack");
      if (keys.length === 0) return base;
      if (depth > ctx.depth && ctx.depth !== null) return base;
      braces = ["{", "}"];
      formatter = () => [];
    } else if (value instanceof Promise) {
      if (depth > ctx.depth && ctx.depth !== null) return "[Promise]";
      const st = env.promiseState(value);
      braces = ["Promise {", "}"];
      formatter = (c, v, d) => {
        if (st === undefined || st[0] === 0) return ["<pending>"];
        if (st[0] === 1) return [fmtValue(c, st[1], d + 1)];
        return ["<rejected> " + fmtValue(c, st[1], d + 1)];
      };
    } else if (value instanceof ArrayBuffer) {
      if (depth > ctx.depth && ctx.depth !== null) return "[ArrayBuffer]";
      const u8 = new Uint8Array(value);
      const n = Math.min(ctx.maxArrayLength, u8.length);
      let contents = "<" + hexSlice(u8, n);
      if (u8.length > n) {
        const rest = u8.length - n;
        contents += (n > 0 ? " " : "") + "... " + rest + " more byte" + (rest > 1 ? "s" : "");
      }
      contents += ">";
      braces = ["ArrayBuffer {", "}"];
      const bl = value.byteLength;
      formatter = () => ["[Uint8Contents]: " + contents, "[byteLength]: " + fmtNumber(bl)];
    } else {
      const boxed = (() => {
        const tag = Object.prototype.toString.call(value).slice(8, -1);
        if (tag === "String") return "[String: " + quoteStr(String.prototype.valueOf.call(value)) + "]";
        if (tag === "Number") return "[Number: " + fmtNumber(Number.prototype.valueOf.call(value)) + "]";
        if (tag === "Boolean") return "[Boolean: " + Boolean.prototype.valueOf.call(value) + "]";
        if (tag === "Symbol") return "[Symbol: " + String(Symbol.prototype.valueOf.call(value)) + "]";
        if (tag === "BigInt") return "[BigInt: " + fmtBigInt(BigInt.prototype.valueOf.call(value)) + "]";
        return null;
      })();
      if (boxed !== null) {
        base = boxed;
        if (Object.prototype.toString.call(value).slice(8, -1) === "String") {
          const len = String.prototype.valueOf.call(value).length;
          keys = keys.filter((k) => !(typeof k === "string" && /^\d+$/.test(k) && +k < len));
        }
        if (keys.length === 0) return base;
        braces = ["{", "}"];
        formatter = () => [];
      } else {
        if (depth > ctx.depth && ctx.depth !== null) {
          return "[" + (ctorName === null ? "Object: null prototype" : ctorName) + "]";
        }
        if (protoOf === null) {
          base = "[Object: null prototype]";
          braces = ["{", "}"];
        } else if (ctorName !== "Object" && ctorName !== null) {
          braces = [ctorName + " {", "}"];
        } else {
          braces = ["{", "}"];
        }
        if (keys.length === 0) {
          if (base !== "") return base + " {}";
          return braces[0] === "{" ? "{}" : braces[0] + "}";
        }
        formatter = () => [];
      }
    }
    ctx.seen.push(value);
    ctx.currentDepth = depth;
    let output;
    try {
      output = formatter(ctx, value, depth);
      for (const k of keys) {
        output.push(fmtProperty(ctx, value, k, depth));
      }
    } finally {
      ctx.seen.pop();
    }
    if (ctx.sorted) output.sort();
    const res = reduceToSingleString(ctx, output, base, braces, isArrayLike, depth, value);
    if (ctx.circular !== undefined) {
      const index = ctx.circular.get(value);
      if (index !== undefined) return "<ref *" + index + "> " + res;
    }
    return res;
  };
  function inspect(value, showHiddenOrOpts, depthArg, colorsArg) {
    const ctx = {
      showHidden: false, depth: 2, colors: false, customInspect: true,
      maxArrayLength: 100, maxStringLength: 10000, breakLength: 128,
      compact: 3, sorted: false, getters: false, numericSeparator: false,
      seen: [], circular: undefined, indentationLvl: 0, currentDepth: 0,
    };
    if (arguments.length > 1) {
      if (typeof showHiddenOrOpts === "boolean") {
        ctx.showHidden = showHiddenOrOpts;
        if (depthArg !== undefined) ctx.depth = depthArg;
        if (colorsArg !== undefined) ctx.colors = colorsArg;
      } else if (showHiddenOrOpts !== null && typeof showHiddenOrOpts === "object") {
        for (const k of Object.keys(showHiddenOrOpts)) {
          if (showHiddenOrOpts[k] !== undefined || k in ctx) ctx[k] = showHiddenOrOpts[k];
        }
      }
    }
    if (ctx.maxArrayLength === null) ctx.maxArrayLength = Infinity;
    if (ctx.maxStringLength === null) ctx.maxStringLength = Infinity;
    if (ctx.breakLength === null) ctx.breakLength = Infinity;
    if (ctx.compact === false) ctx.compact = 0;
    return fmtValue(ctx, value, 0);
  }
  inspect.custom = inspectCustom;
  inspect.defaultOptions = {
    showHidden: false, depth: 2, colors: false, customInspect: true,
    showProxy: false, maxArrayLength: 100, maxStringLength: 10000,
    breakLength: 128, compact: 3, sorted: false, getters: false,
    numericSeparator: false,
  };
  inspect.colors = {
    reset: [0, 0], bold: [1, 22], dim: [2, 22], italic: [3, 23],
    underline: [4, 24], blink: [5, 25], inverse: [7, 27], hidden: [8, 28],
    strikethrough: [9, 29], doubleunderline: [21, 24], black: [30, 39],
    red: [31, 39], green: [32, 39], yellow: [33, 39], blue: [34, 39],
    magenta: [35, 39], cyan: [36, 39], white: [37, 39], bgBlack: [40, 49],
    bgRed: [41, 49], bgGreen: [42, 49], bgYellow: [43, 49], bgBlue: [44, 49],
    bgMagenta: [45, 49], bgCyan: [46, 49], bgWhite: [47, 49],
    framed: [51, 54], overlined: [53, 55], gray: [90, 39], redBright: [91, 39],
    greenBright: [92, 39], yellowBright: [93, 39], blueBright: [94, 39],
    magentaBright: [95, 39], cyanBright: [96, 39], whiteBright: [97, 39],
    bgGray: [100, 49], bgRedBright: [101, 49], bgGreenBright: [102, 49],
    bgYellowBright: [103, 49], bgBlueBright: [104, 49],
    bgMagentaBright: [105, 49], bgCyanBright: [106, 49], bgWhiteBright: [107, 49],
  };
  const formatWithOptions = (opts, ...args) => {
    let first = args[0];
    let a = 0;
    let str = "";
    let joined = "";
    if (typeof first === "string" && first.includes("%")) {
      a = 1;
      let lastPos = 0;
      for (let i = 0; i < first.length - 1; i++) {
        if (first[i] !== "%") continue;
        const next = first[++i];
        let tempStr;
        if (next === "%") {
          str += first.slice(lastPos, i - 1) + "%";
          lastPos = i + 1;
          continue;
        }
        if (a >= args.length) continue;
        switch (next) {
          case "s": {
            const arg = args[a];
            if (typeof arg === "number") tempStr = fmtNumber(arg);
            else if (typeof arg === "bigint") tempStr = fmtBigInt(arg);
            else if (typeof arg !== "object" || arg === null) tempStr = String(arg);
            else tempStr = inspect(arg, { ...opts, compact: 3, colors: false, depth: 0 });
            break;
          }
          case "j":
            try { tempStr = JSON.stringify(args[a]); }
            catch (e) { tempStr = "[Circular]"; }
            break;
          case "d": {
            const arg = args[a];
            if (typeof arg === "bigint") tempStr = fmtBigInt(arg);
            else if (typeof arg === "symbol") tempStr = "NaN";
            else tempStr = fmtNumber(Number(arg));
            break;
          }
          case "O":
            tempStr = inspect(args[a], { ...opts });
            break;
          case "o":
            tempStr = inspect(args[a], { ...opts, showHidden: true, showProxy: true, depth: 4 });
            break;
          case "i": {
            const arg = args[a];
            if (typeof arg === "bigint") tempStr = fmtBigInt(arg);
            else if (typeof arg === "symbol") tempStr = "NaN";
            else tempStr = fmtNumber(parseInt(arg));
            break;
          }
          case "f": {
            const arg = args[a];
            if (typeof arg === "symbol") tempStr = "NaN";
            else tempStr = fmtNumber(parseFloat(arg));
            break;
          }
          case "c":
            a += 1;
            lastPos = i + 1;
            continue;
          default:
            continue;
        }
        if (lastPos !== i - 1) str += first.slice(lastPos, i - 1);
        str += tempStr;
        lastPos = i + 1;
        a++;
      }
      if (lastPos !== 0) {
        if (lastPos < first.length) str += first.slice(lastPos);
        first = str;
        str = "";
      } else {
        str = "";
      }
      joined = first;
    }
    while (a < args.length) {
      const value = args[a];
      joined += a > 0 || typeof first !== "string" && a === 0 ? "" : "";
      if (joined !== "" || a > 0) joined += " ";
      joined += typeof value !== "string" ? inspect(value, opts) : value;
      a++;
    }
    return joined;
  };
  const format = (...args) => formatWithOptions({}, ...args);
  const inherits = (ctor, superCtor) => {
    if (ctor === undefined || ctor === null) {
      const e = new TypeError('The "ctor" argument must be of type function. Received ' + (ctor === null ? "null" : "undefined"));
      e.code = "ERR_INVALID_ARG_TYPE";
      throw e;
    }
    if (superCtor === undefined || superCtor === null) {
      const e = new TypeError('The "superCtor" argument must be of type function. Received ' + (superCtor === null ? "null" : "undefined"));
      e.code = "ERR_INVALID_ARG_TYPE";
      throw e;
    }
    if (superCtor.prototype === undefined) {
      const e = new TypeError('The "superCtor.prototype" argument must be of type object. Received undefined');
      e.code = "ERR_INVALID_ARG_TYPE";
      throw e;
    }
    Object.defineProperty(ctor, "super_", { value: superCtor, writable: true, configurable: true });
    Object.setPrototypeOf(ctor.prototype, superCtor.prototype);
  };
  const kCustomPromisified = Symbol.for("nodejs.util.promisify.custom");
  const kCustomPromisifyArgs = Symbol("customPromisifyArgs");
  const promisify = (original) => {
    if (typeof original !== "function") {
      const e = new TypeError('The "original" argument must be of type function. Received ' + (original === null ? "null" : typeof original === "object" ? "an instance of Object" : typeof original === "undefined" ? "undefined" : "type " + typeof original + " (" + JSON.stringify(original) + ")"));
      e.code = "ERR_INVALID_ARG_TYPE";
      throw e;
    }
    if (original[kCustomPromisified]) {
      const fn = original[kCustomPromisified];
      if (typeof fn !== "function") {
        const e = new TypeError('The "util.promisify.custom" property must be of type function');
        e.code = "ERR_INVALID_ARG_TYPE";
        throw e;
      }
      return Object.defineProperty(fn, kCustomPromisified, { value: fn, enumerable: false, writable: false, configurable: true });
    }
    const argumentNames = original[kCustomPromisifyArgs];
    function fn(...args) {
      return new Promise((resolve, reject) => {
        args.push((err, ...values) => {
          if (err) return reject(err);
          if (argumentNames !== undefined && values.length > 1) {
            const obj = {};
            for (let i = 0; i < argumentNames.length; i++) obj[argumentNames[i]] = values[i];
            resolve(obj);
          } else {
            resolve(values[0]);
          }
        });
        Reflect.apply(original, this, args);
      });
    }
    Object.setPrototypeOf(fn, Object.getPrototypeOf(original));
    Object.defineProperty(fn, kCustomPromisified, { value: fn, enumerable: false, writable: false, configurable: true });
    const descriptors = Object.getOwnPropertyDescriptors(original);
    delete descriptors.name;
    delete descriptors.length;
    return Object.defineProperties(fn, descriptors);
  };
  promisify.custom = kCustomPromisified;
  const callbackify = (original) => {
    if (typeof original !== "function") {
      const e = new TypeError('The "original" argument must be of type function');
      e.code = "ERR_INVALID_ARG_TYPE";
      throw e;
    }
    function callbackified(...args) {
      const maybeCb = args.pop();
      if (typeof maybeCb !== "function") {
        const e = new TypeError("The last argument must be of type function");
        e.code = "ERR_INVALID_ARG_TYPE";
        throw e;
      }
      const cb = (...cbArgs) => Reflect.apply(maybeCb, this, cbArgs);
      Reflect.apply(original, this, args).then(
        (ret) => queueMicrotask(() => cb(null, ret)),
        (rej) => queueMicrotask(() => {
          if (rej === null || (typeof rej !== "object" && typeof rej !== "function")) {
            const wrapped = new Error("Promise was rejected with a falsy value");
            wrapped.code = "ERR_FALSY_VALUE_REJECTION";
            wrapped.reason = rej;
            return cb(wrapped);
          }
          return cb(rej);
        }),
      );
    }
    Object.setPrototypeOf(callbackified, Object.getPrototypeOf(original));
    const descriptors = Object.getOwnPropertyDescriptors(original);
    Object.defineProperties(callbackified, descriptors);
    return callbackified;
  };
  const deprecate = (fn, msg, code) => {
    if (typeof fn !== "function") {
      const e = new TypeError('The "fn" argument must be of type function');
      e.code = "ERR_INVALID_ARG_TYPE";
      throw e;
    }
    let warned = false;
    function deprecated(...args) {
      if (!warned) {
        warned = true;
        const prefix = code !== undefined ? "[" + code + "] DeprecationWarning" : "DeprecationWarning";
        env.writeErr("(node:" + env.pid + ") " + prefix + ": " + msg + "\n");
      }
      if (new.target) return Reflect.construct(fn, args, new.target);
      return Reflect.apply(fn, this, args);
    }
    return deprecated;
  };
  let debugEnvSet;
  const debuglog = (set, cb) => {
    if (debugEnvSet === undefined) {
      debugEnvSet = new Set(
        String(env.env.NODE_DEBUG || "").toLowerCase().split(",").map((s) => s.trim()).filter((s) => s !== ""),
      );
    }
    set = String(set).toLowerCase();
    const enabled = debugEnvSet.has(set) || [...debugEnvSet].some((p) =>
      p.includes("*") && new RegExp("^" + p.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*") + "$").test(set));
    let fn;
    if (enabled) {
      const setUpper = set.toUpperCase();
      fn = (...args) => {
        env.writeErr(setUpper + " " + env.pid + ": " + format(...args) + "\n");
      };
    } else {
      fn = () => {};
    }
    Object.defineProperty(fn, "enabled", { get: () => enabled, configurable: true });
    if (typeof cb === "function") cb(fn);
    return fn;
  };
  const tagOf = (v) => Object.prototype.toString.call(v).slice(8, -1);
  const taggedTest = (tag) => (v) => tagOf(v) === tag && typeof v === "object";
  const taTagGetter = Object.getOwnPropertyDescriptor(
    Object.getPrototypeOf(Object.getPrototypeOf(new Uint8Array(0))), Symbol.toStringTag).get;
  const brandTA = (v) => {
    try {
      return taTagGetter.call(v) !== undefined;
    } catch (e) {
      return false;
    }
  };
  const types = {
    isAnyArrayBuffer: (v) => tagOf(v) === "ArrayBuffer" || tagOf(v) === "SharedArrayBuffer",
    isArrayBufferView: (v) => ArrayBuffer.isView(v),
    isArgumentsObject: taggedTest("Arguments"),
    isArrayBuffer: (v) => {
      try { Object.getOwnPropertyDescriptor(ArrayBuffer.prototype, "byteLength").get.call(v); return true; }
      catch (e) { return false; }
    },
    isAsyncFunction: (v) => typeof v === "function" && tagOf(v) === "AsyncFunction",
    isBigInt64Array: (v) => tagOf(v) === "BigInt64Array",
    isBigUint64Array: (v) => tagOf(v) === "BigUint64Array",
    isBooleanObject: (v) => {
      try { Boolean.prototype.valueOf.call(v); return typeof v === "object"; }
      catch (e) { return false; }
    },
    isBoxedPrimitive: (v) =>
      types.isStringObject(v) || types.isNumberObject(v) || types.isBooleanObject(v) ||
      types.isSymbolObject(v) || types.isBigIntObject(v),
    isBigIntObject: (v) => {
      try { BigInt.prototype.valueOf.call(v); return typeof v === "object"; }
      catch (e) { return false; }
    },
    isCryptoKey: () => false,
    isDataView: (v) => {
      try { Object.getOwnPropertyDescriptor(DataView.prototype, "byteLength").get.call(v); return true; }
      catch (e) { return false; }
    },
    isDate: (v) => {
      try { Date.prototype.getTime.call(v); return true; }
      catch (e) { return false; }
    },
    isExternal: () => false,
    isFloat16Array: (v) => tagOf(v) === "Float16Array",
    isFloat32Array: (v) => tagOf(v) === "Float32Array",
    isFloat64Array: (v) => tagOf(v) === "Float64Array",
    isGeneratorFunction: (v) => typeof v === "function" && tagOf(v) === "GeneratorFunction",
    isGeneratorObject: (v) => typeof v === "object" && v !== null && tagOf(v) === "Generator",
    isInt8Array: (v) => tagOf(v) === "Int8Array",
    isInt16Array: (v) => tagOf(v) === "Int16Array",
    isInt32Array: (v) => tagOf(v) === "Int32Array",
    isKeyObject: () => false,
    isMap: (v) => {
      try { Object.getOwnPropertyDescriptor(Map.prototype, "size").get.call(v); return true; }
      catch (e) { return false; }
    },
    isMapIterator: (v) => tagOf(v) === "Map Iterator",
    isModuleNamespaceObject: (v) => typeof v === "object" && v !== null && tagOf(v) === "Module",
    isNativeError: (v) => v instanceof Error && (
      ["Error", "EvalError", "RangeError", "ReferenceError", "SyntaxError", "TypeError", "URIError", "AggregateError", "SuppressedError"].includes(tagOf(v))
    ),
    isNumberObject: (v) => {
      try { Number.prototype.valueOf.call(v); return typeof v === "object"; }
      catch (e) { return false; }
    },
    isPromise: (v) => v instanceof Promise,
    isProxy: () => false,
    isRegExp: (v) => tagOf(v) === "RegExp",
    isSet: (v) => {
      try { Object.getOwnPropertyDescriptor(Set.prototype, "size").get.call(v); return true; }
      catch (e) { return false; }
    },
    isSetIterator: (v) => tagOf(v) === "Set Iterator",
    isSharedArrayBuffer: (v) => tagOf(v) === "SharedArrayBuffer",
    isStringObject: (v) => {
      try { String.prototype.valueOf.call(v); return typeof v === "object"; }
      catch (e) { return false; }
    },
    isSymbolObject: (v) => {
      try { Symbol.prototype.valueOf.call(v); return typeof v === "object"; }
      catch (e) { return false; }
    },
    isTypedArray: brandTA,
    isUint8Array: (v) => tagOf(v) === "Uint8Array",
    isUint8ClampedArray: (v) => tagOf(v) === "Uint8ClampedArray",
    isUint16Array: (v) => tagOf(v) === "Uint16Array",
    isUint32Array: (v) => tagOf(v) === "Uint32Array",
    isWeakMap: (v) => {
      try { WeakMap.prototype.has.call(v, {}); return true; }
      catch (e) { return false; }
    },
    isWeakSet: (v) => {
      try { WeakSet.prototype.has.call(v, {}); return true; }
      catch (e) { return false; }
    },
  };
  const deepEquals = (a, b, memos) => {
    if (Object.is(a, b)) return true;
    const ta = typeof a;
    const tb = typeof b;
    if (ta !== tb) return false;
    if (ta === "number") return Number.isNaN(a) && Number.isNaN(b);
    if (ta !== "object" && ta !== "function") return false;
    if (a === null || b === null) return false;
    const tagA = tagOf(a);
    if (tagA !== tagOf(b)) return false;
    if (Object.getPrototypeOf(a) !== Object.getPrototypeOf(b)) return false;
    if (tagA === "Date") return Object.is(Date.prototype.getTime.call(a), Date.prototype.getTime.call(b));
    if (tagA === "RegExp") return String(a) === String(b);
    if (Array.isArray(a) && a.length !== b.length) return false;
    if (types.isTypedArray(a)) {
      if (a.length !== b.length) return false;
      if (tagA === "Float32Array" || tagA === "Float64Array" || tagA === "Float16Array") {
        for (let i = 0; i < a.length; i++) if (!Object.is(a[i], b[i])) return false;
      } else {
        for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
      }
      return true;
    }
    if (tagA === "ArrayBuffer") {
      const ua = new Uint8Array(a);
      const ub = new Uint8Array(b);
      if (ua.length !== ub.length) return false;
      for (let i = 0; i < ua.length; i++) if (ua[i] !== ub[i]) return false;
      return true;
    }
    if (a instanceof Error && (a.message !== b.message || a.name !== b.name)) return false;
    if (types.isBoxedPrimitive(a)) {
      return Object.is(
        (tagA === "String" ? String.prototype.valueOf : tagA === "Number" ? Number.prototype.valueOf
          : tagA === "Boolean" ? Boolean.prototype.valueOf : tagA === "BigInt" ? BigInt.prototype.valueOf
          : Symbol.prototype.valueOf).call(a),
        (tagA === "String" ? String.prototype.valueOf : tagA === "Number" ? Number.prototype.valueOf
          : tagA === "Boolean" ? Boolean.prototype.valueOf : tagA === "BigInt" ? BigInt.prototype.valueOf
          : Symbol.prototype.valueOf).call(b));
    }
    memos = memos || { a: new Map(), b: new Map(), position: 0 };
    const memoA = memos.a.get(a);
    if (memoA !== undefined) {
      const memoB = memos.b.get(b);
      if (memoB !== undefined) return memoA === memoB;
    }
    memos.position++;
    memos.a.set(a, memos.position);
    memos.b.set(b, memos.position);
    try {
      if (tagA === "Map") {
        if (a.size !== b.size) return false;
        outer: for (const [k, v] of a) {
          if (b.has(k)) {
            if (deepEquals(v, b.get(k), memos)) continue;
          }
          for (const [k2, v2] of b) {
            if (deepEquals(k, k2, memos) && deepEquals(v, v2, memos)) continue outer;
          }
          return false;
        }
        return true;
      }
      if (tagA === "Set") {
        if (a.size !== b.size) return false;
        outer2: for (const v of a) {
          if (b.has(v)) continue;
          for (const v2 of b) {
            if (deepEquals(v, v2, memos)) continue outer2;
          }
          return false;
        }
        return true;
      }
      const keysA = Object.keys(a);
      const keysB = Object.keys(b);
      if (keysA.length !== keysB.length) return false;
      for (const k of keysA) {
        if (!Object.prototype.propertyIsEnumerable.call(b, k)) return false;
        if (!deepEquals(a[k], b[k], memos)) return false;
      }
      const symsA = Object.getOwnPropertySymbols(a).filter((s) => Object.prototype.propertyIsEnumerable.call(a, s));
      const symsB = Object.getOwnPropertySymbols(b).filter((s) => Object.prototype.propertyIsEnumerable.call(b, s));
      if (symsA.length !== symsB.length) return false;
      for (const s of symsA) {
        if (!Object.prototype.propertyIsEnumerable.call(b, s)) return false;
        if (!deepEquals(a[s], b[s], memos)) return false;
      }
      return true;
    } finally {
      memos.a.delete(a);
      memos.b.delete(b);
    }
  };
  const isDeepStrictEqual = (a, b) => deepEquals(a, b, undefined);
  const ansiRe = /[\u001b][[\]()#;?]*(?:(?:(?:(?:;[-a-zA-Z\d\/\\#&.:=?%@~_]+)*|[a-zA-Z\d]+(?:;[-a-zA-Z\d\/\\#&.:=?%@~_]*)*)?(?:|\u001b\|))|(?:(?:\d{1,4}(?:;\d{0,4})*)?[\dA-PR-TZcf-nq-uy=><~]))/g;
  const stripVTControlCharacters = (str) => {
    if (typeof str !== "string") {
      const e = new TypeError('The "str" argument must be of type string. Received ' + (str === null ? "null" : typeof str === "object" ? "an instance of Object" : typeof str === "undefined" ? "undefined" : "type " + typeof str));
      e.code = "ERR_INVALID_ARG_TYPE";
      throw e;
    }
    return str.replace(ansiRe, "");
  };
  const styleText = (fmt, text, options) => {
    if (typeof text !== "string") {
      const e = new TypeError('The "text" argument must be of type string. Received ' + (text === null ? "null" : typeof text === "object" ? "an instance of Object" : typeof text === "undefined" ? "undefined" : "type " + typeof text));
      e.code = "ERR_INVALID_ARG_TYPE";
      throw e;
    }
    const stream = options !== undefined && options !== null && options.stream !== undefined
      ? options.stream : env.stdout;
    let colorize = !!(stream && stream.isTTY);
    if (env.env.NO_COLOR !== undefined || env.env.NODE_DISABLE_COLORS !== undefined) colorize = false;
    if (env.env.FORCE_COLOR !== undefined && env.env.FORCE_COLOR !== "0") colorize = true;
    const formats = Array.isArray(fmt) ? fmt : [fmt];
    let left = "";
    let right = "";
    for (const f of formats) {
      const pair = inspect.colors[f];
      if (pair === undefined) {
        const e = new TypeError("The value \"" + String(f) + "\" is invalid for argument 'format'. Reason: must be one of: " + Object.keys(inspect.colors).join(", "));
        e.code = "ERR_INVALID_ARG_VALUE";
        throw e;
      }
      left += "\u001b[" + pair[0] + "m";
      right = "\u001b[" + pair[1] + "m" + right;
    }
    return colorize ? left + text + right : text;
  };
  const parseArgs = (config) => {
    config = config === undefined ? {} : config;
    const args = config.args !== undefined ? config.args : env.argv.slice(2);
    const strict = config.strict !== undefined ? !!config.strict : true;
    const allowPositionals = config.allowPositionals !== undefined ? !!config.allowPositionals : !strict;
    const allowNegative = !!config.allowNegative;
    const returnTokens = !!config.tokens;
    const options = config.options !== undefined ? config.options : {};
    const result = { values: { __proto__: null }, positionals: [] };
    const tokens = [];
    const shortOf = (ch) => {
      for (const name of Object.keys(options)) {
        if (options[name].short === ch) return name;
      }
      return undefined;
    };
    const unknownError = (raw) => {
      const e = new TypeError("Unknown option '" + raw + "'. To specify a positional argument starting with a '-', place it at the end of the command after '--', as in '-- \"" + raw + "\"");
      e.code = "ERR_PARSE_ARGS_UNKNOWN_OPTION";
      throw e;
    };
    const store = (name, value, raw) => {
      const cfg = options[name] || {};
      const type = cfg.type;
      if (strict) {
        if (options[name] === undefined) unknownError(raw);
        if (type === "string" && value === undefined) {
          const e = new TypeError("Option '" + raw + (cfg.short && raw.startsWith("--") === false ? "" : "") + " <value>' argument missing");
          e.code = "ERR_PARSE_ARGS_INVALID_OPTION_VALUE";
          throw e;
        }
        if (type === "boolean" && value !== undefined) {
          const e = new TypeError("Option '" + raw + "' does not take an argument");
          e.code = "ERR_PARSE_ARGS_INVALID_OPTION_VALUE";
          throw e;
        }
      }
      const finalValue = value === undefined ? true : value;
      tokens.push({ kind: "option", name, rawName: raw, index: tokenIndex, value: value === undefined ? undefined : value, inlineValue: inline });
      if (cfg.multiple) {
        if (result.values[name] === undefined) result.values[name] = [];
        result.values[name].push(finalValue);
      } else {
        result.values[name] = finalValue;
      }
    };
    let tokenIndex = -1;
    let inline;
    let afterDashDash = false;
    for (let i = 0; i < args.length; i++) {
      const arg = args[i];
      tokenIndex = i;
      inline = undefined;
      if (afterDashDash) {
        tokens.push({ kind: "positional", index: i, value: arg });
        result.positionals.push(arg);
        continue;
      }
      if (arg === "--") {
        afterDashDash = true;
        tokens.push({ kind: "option-terminator", index: i });
        continue;
      }
      if (arg.startsWith("--")) {
        const eq = arg.indexOf("=");
        if (eq !== -1) {
          const name = arg.slice(2, eq);
          inline = true;
          store(name, arg.slice(eq + 1), "--" + name);
        } else {
          const name = arg.slice(2);
          const cfg = options[name];
          if (cfg !== undefined && cfg.type === "string" && i + 1 < args.length) {
            inline = false;
            store(name, args[++i], arg);
          } else if (allowNegative && name.startsWith("no-") && (options[name.slice(3)] || {}).type === "boolean") {
            const positive = name.slice(3);
            tokens.push({ kind: "option", name: positive, rawName: arg, index: i, value: undefined, inlineValue: undefined });
            result.values[positive] = false;
          } else {
            if (strict && cfg === undefined) unknownError(arg);
            if (strict && cfg.type === "string") {
              const e = new TypeError("Option '--" + name + " <value>' argument missing");
              e.code = "ERR_PARSE_ARGS_INVALID_OPTION_VALUE";
              throw e;
            }
            store(name, undefined, arg);
          }
        }
        continue;
      }
      if (arg.length > 1 && arg[0] === "-") {
        const chars = arg.slice(1);
        let consumed = false;
        for (let c = 0; c < chars.length; c++) {
          const ch = chars[c];
          const name = shortOf(ch);
          const raw = "-" + ch;
          const cfg = name !== undefined ? options[name] : undefined;
          if (cfg !== undefined && cfg.type === "string") {
            if (c < chars.length - 1) {
              inline = true;
              store(name, chars.slice(c + 1), raw);
            } else if (i + 1 < args.length) {
              inline = false;
              store(name, args[++i], raw);
            } else if (strict) {
              const e = new TypeError("Option '" + raw + ", --" + name + " <value>' argument missing");
              e.code = "ERR_PARSE_ARGS_INVALID_OPTION_VALUE";
              throw e;
            } else {
              store(name, undefined, raw);
            }
            consumed = true;
            break;
          }
          if (name === undefined) {
            if (strict) unknownError(raw);
            store(ch, undefined, raw);
          } else {
            store(name, undefined, raw);
          }
        }
        void consumed;
        continue;
      }
      if (strict && !allowPositionals) {
        const e = new TypeError("Unexpected argument '" + arg + "'. This command does not take positional arguments");
        e.code = "ERR_PARSE_ARGS_UNEXPECTED_POSITIONAL";
        throw e;
      }
      tokens.push({ kind: "positional", index: i, value: arg });
      result.positionals.push(arg);
    }
    for (const name of Object.keys(options)) {
      const cfg = options[name];
      if (cfg.default !== undefined && !(name in result.values)) {
        result.values[name] = cfg.default;
      }
    }
    if (returnTokens) result.tokens = tokens;
    return result;
  };
  const toUSVString = (s) => String(s).replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, "�");
  const _extend = (target, source) => {
    if (source === null || typeof source !== "object") return target;
    for (const k of Object.keys(source)) target[k] = source[k];
    return target;
  };
  const util = {
    format, formatWithOptions, inspect, inherits, promisify, callbackify,
    deprecate, debuglog, debug: debuglog, types, isDeepStrictEqual,
    stripVTControlCharacters, styleText, parseArgs, toUSVString, _extend,
    TextEncoder: globalThis.TextEncoder, TextDecoder: globalThis.TextDecoder,
    isArray: (v) => Array.isArray(v),
  };
  return util;
}
    const util = makeUtil({
      promiseState: (p) => host.promiseState(p),
      writeErr: (s) => host.write(2, s),
      env: builtins.process().env,
      pid: host.pid(),
      argv: builtins.process().argv,
      stdout: builtins.process().stdout,
    });
    util.default = util;
    return util;
  });
    /* node:util/types IS util.types (Node aliases the module to the
     * same object; require('util/types') === require('util').types). */
  builtins['util/types'] = memo(() => {
    const t = builtins.util().types;
    t.default = t;
    return t;
  });
