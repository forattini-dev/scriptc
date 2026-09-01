    /* node:path — the bare module binds by TARGET (Node on Windows IS
     * path.win32) and both namespaces are always available; every
     * member except parse/format rides scr_path.c's byte-exact ports
     * through the host path hook, parse/format are Node v24's
     * algorithms ported here. */
  builtins.path = memo(() => {
const CHAR_DOT = ".";
const isSepP = (c) => c === "/";
const isSepW = (c) => c === "/" || c === "\\";
const isLetter = (c) => (c >= "a" && c <= "z") || (c >= "A" && c <= "Z");
function parsePosix(path) {
  if (typeof path !== "string") {
    const e = new TypeError('The "path" argument must be of type string. Received ' + (path === null ? "null" : typeof path === "object" ? "an instance of " + ((path.constructor && path.constructor.name) || "Object") : "type " + typeof path + " (" + JSON.stringify(path) + ")"));
    e.code = "ERR_INVALID_ARG_TYPE";
    throw e;
  }
  const ret = { root: "", dir: "", base: "", ext: "", name: "" };
  if (path.length === 0) return ret;
  const isAbs = path[0] === "/";
  let start;
  if (isAbs) {
    ret.root = "/";
    start = 1;
  } else {
    start = 0;
  }
  let startDot = -1;
  let startPart = 0;
  let end = -1;
  let matchedSlash = true;
  let preDotState = 0;
  for (let i = path.length - 1; i >= start; --i) {
    const ch = path[i];
    if (isSepP(ch)) {
      if (!matchedSlash) {
        startPart = i + 1;
        break;
      }
      continue;
    }
    if (end === -1) {
      matchedSlash = false;
      end = i + 1;
    }
    if (ch === CHAR_DOT) {
      if (startDot === -1) startDot = i;
      else if (preDotState !== 1) preDotState = 1;
    } else if (startDot !== -1) {
      preDotState = -1;
    }
  }
  if (end !== -1) {
    const s = startPart === 0 && isAbs ? 1 : startPart;
    if (startDot === -1 || preDotState === 0 ||
        (preDotState === 1 && startDot === end - 1 && startDot === startPart + 1)) {
      ret.base = ret.name = path.slice(s, end);
    } else {
      ret.name = path.slice(s, startDot);
      ret.base = path.slice(s, end);
      ret.ext = path.slice(startDot, end);
    }
  }
  if (startPart > 0) ret.dir = path.slice(0, startPart - 1);
  else if (isAbs) ret.dir = "/";
  return ret;
}
function parseWin32(path) {
  if (typeof path !== "string") {
    const e = new TypeError('The "path" argument must be of type string. Received ' + (path === null ? "null" : typeof path === "object" ? "an instance of " + ((path.constructor && path.constructor.name) || "Object") : "type " + typeof path + " (" + JSON.stringify(path) + ")"));
    e.code = "ERR_INVALID_ARG_TYPE";
    throw e;
  }
  const ret = { root: "", dir: "", base: "", ext: "", name: "" };
  if (path.length === 0) return ret;
  const len = path.length;
  let rootEnd = 0;
  let ch = path[0];
  if (len === 1) {
    if (isSepW(ch)) {
      ret.root = ret.dir = path;
      return ret;
    }
    ret.base = ret.name = path;
    return ret;
  }
  if (isSepW(ch)) {
    rootEnd = 1;
    if (isSepW(path[1])) {
      let j = 2;
      let last = j;
      while (j < len && !isSepW(path[j])) j++;
      if (j < len && j !== last) {
        last = j;
        while (j < len && isSepW(path[j])) j++;
        if (j < len && j !== last) {
          last = j;
          while (j < len && !isSepW(path[j])) j++;
          if (j === len) rootEnd = j;
          else if (j !== last) rootEnd = j + 1;
        }
      }
    }
  } else if (isLetter(ch) && path[1] === ":") {
    if (len <= 2) {
      ret.root = ret.dir = path;
      return ret;
    }
    rootEnd = 2;
    if (isSepW(path[2])) {
      if (len === 3) {
        ret.root = ret.dir = path;
        return ret;
      }
      rootEnd = 3;
    }
  }
  if (rootEnd > 0) ret.root = path.slice(0, rootEnd);
  let startDot = -1;
  let startPart = rootEnd;
  let end = -1;
  let matchedSlash = true;
  let i = path.length - 1;
  let preDotState = 0;
  for (; i >= rootEnd; --i) {
    ch = path[i];
    if (isSepW(ch)) {
      if (!matchedSlash) {
        startPart = i + 1;
        break;
      }
      continue;
    }
    if (end === -1) {
      matchedSlash = false;
      end = i + 1;
    }
    if (ch === CHAR_DOT) {
      if (startDot === -1) startDot = i;
      else if (preDotState !== 1) preDotState = 1;
    } else if (startDot !== -1) {
      preDotState = -1;
    }
  }
  if (end !== -1) {
    if (startDot === -1 || preDotState === 0 ||
        (preDotState === 1 && startDot === end - 1 && startDot === startPart + 1)) {
      ret.base = ret.name = path.slice(startPart, end);
    } else {
      ret.name = path.slice(startPart, startDot);
      ret.base = path.slice(startPart, end);
      ret.ext = path.slice(startDot, end);
    }
  }
  if (startPart > 0 && startPart !== rootEnd) ret.dir = path.slice(0, startPart - 1);
  else ret.dir = ret.root;
  return ret;
}
function makeFormat(sep) {
  return (obj) => {
    if (obj === null || typeof obj !== "object") {
      const e = new TypeError('The "pathObject" argument must be of type object. Received ' + (obj === null ? "null" : "type " + typeof obj + " (" + JSON.stringify(obj) + ")"));
      e.code = "ERR_INVALID_ARG_TYPE";
      throw e;
    }
    const dir = obj.dir || obj.root;
    const base = obj.base || ((obj.name || "") + (obj.ext || ""));
    if (!dir) return base;
    return dir === obj.root ? dir + base : dir + sep + base;
  };
}
    const badPath = (p) => {
      const t = p === null ? 'null' : typeof p === 'object' ? 'an instance of ' + ((p.constructor && p.constructor.name) || 'Object') : 'type ' + typeof p + ' (' + String(p) + ')';
      const e = new TypeError('The "path" argument must be of type string. Received ' + t);
      e.code = 'ERR_INVALID_ARG_TYPE';
      return e;
    };
    const str = (p) => {
      if (typeof p !== 'string') throw badPath(p);
      return p;
    };
    const mkFamily = (w) => {
      const sep = w ? '\\' : '/';
      const P = {
        sep,
        delimiter: w ? ';' : ':',
        join: (...parts) => host.path('join', w, parts.map(str)),
        resolve: (...parts) => host.path('resolve', w, parts.map(str)),
        normalize: (p) => host.path('normalize', w, str(p)),
        dirname: (p) => host.path('dirname', w, str(p)),
        basename: (p, suffix) => host.path('basename', w, str(p), suffix === undefined ? '' : str(suffix)),
        extname: (p) => host.path('extname', w, str(p)),
        isAbsolute: (p) => host.path('isAbsolute', w, str(p)),
        relative: (from, to) => host.path('relative', w, str(from), str(to)),
        toNamespacedPath: (p) => (typeof p === 'string' ? host.path('toNamespacedPath', w, p) : p),
        parse: w ? parseWin32 : parsePosix,
        format: makeFormat(sep),
      };
      return P;
    };
    const posix = mkFamily(false);
    const win32 = mkFamily(true);
    posix.posix = win32.posix = posix;
    posix.win32 = win32.win32 = win32;
    const p = host.platform() === 'win32' ? win32 : posix;
    p.default = p;
    return p;
  });
    /* node:path/posix and node:path/win32 are the namespaces
     * themselves. */
  builtins['path/posix'] = memo(() => {
    const p = builtins.path().posix;
    p.default = p;
    return p;
  });
  builtins['path/win32'] = memo(() => {
    const p = builtins.path().win32;
    p.default = p;
    return p;
  });
