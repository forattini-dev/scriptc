/* Web-platform GLOBALS the embedded graph reaches for at load — pure
 * JavaScript over the prelude's own classes (streams, TextDecoder,
 * DOMException, crypto), booted after island_web.js with the same `host`
 * bridge. Node exposes every one of these as a global; packages in a
 * real CLI's graph destructure them at module evaluation (undici, ws,
 * fetch-blob, formdata-polyfill, the AI SDKs), so the island must LINK
 * them even where it cannot serve them fully: WebSocket constructs to a
 * refusal (no socket kernel behind it yet), CompressionStream too. */
(host) => {
  const global = globalThis;
  const define = (name, value) => {
    if (typeof global[name] === "undefined") {
      Object.defineProperty(global, name, { value, writable: true, configurable: true, enumerable: false });
    }
  };

  /* ── events ──────────────────────────────────────────────────────── */
  class Event {
    #type; #bubbles; #cancelable; #composed; #defaultPrevented = false; #target = null; #stopped = false;
    constructor(type, init = {}) {
      if (arguments.length === 0) throw new TypeError("Event constructor requires a type");
      this.#type = String(type);
      this.#bubbles = !!init.bubbles;
      this.#cancelable = !!init.cancelable;
      this.#composed = !!init.composed;
      this.timeStamp = global.performance ? global.performance.now() : Date.now();
    }
    get type() { return this.#type; }
    get bubbles() { return this.#bubbles; }
    get cancelable() { return this.#cancelable; }
    get composed() { return this.#composed; }
    get defaultPrevented() { return this.#defaultPrevented; }
    get target() { return this.#target; }
    get currentTarget() { return this.#target; }
    get srcElement() { return this.#target; }
    get eventPhase() { return this.#target ? 2 : 0; }
    get isTrusted() { return false; }
    get returnValue() { return !this.#defaultPrevented; }
    get cancelBubble() { return this.#stopped; }
    preventDefault() { if (this.#cancelable) this.#defaultPrevented = true; }
    stopPropagation() { this.#stopped = true; }
    stopImmediatePropagation() { this.#stopped = true; this._immediateStopped = true; }
    composedPath() { return this.#target ? [this.#target] : []; }
    initEvent(type, bubbles, cancelable) { this.#type = String(type); this.#bubbles = !!bubbles; this.#cancelable = !!cancelable; }
    _setTarget(target) { this.#target = target; }
    get [Symbol.toStringTag]() { return "Event"; }
    static get NONE() { return 0; }
    static get CAPTURING_PHASE() { return 1; }
    static get AT_TARGET() { return 2; }
    static get BUBBLING_PHASE() { return 3; }
  }
  class CustomEvent extends Event {
    #detail;
    constructor(type, init = {}) { super(type, init); this.#detail = init.detail === undefined ? null : init.detail; }
    get detail() { return this.#detail; }
    get [Symbol.toStringTag]() { return "CustomEvent"; }
  }
  class ErrorEvent extends Event {
    constructor(type, init = {}) {
      super(type, init);
      this.message = init.message === undefined ? "" : String(init.message);
      this.filename = init.filename === undefined ? "" : String(init.filename);
      this.lineno = init.lineno === undefined ? 0 : init.lineno;
      this.colno = init.colno === undefined ? 0 : init.colno;
      this.error = init.error;
    }
    get [Symbol.toStringTag]() { return "ErrorEvent"; }
  }
  class CloseEvent extends Event {
    constructor(type, init = {}) {
      super(type, init);
      this.wasClean = !!init.wasClean;
      this.code = init.code === undefined ? 0 : init.code;
      this.reason = init.reason === undefined ? "" : String(init.reason);
    }
    get [Symbol.toStringTag]() { return "CloseEvent"; }
  }
  class MessageEvent extends Event {
    constructor(type, init = {}) {
      super(type, init);
      this.data = init.data === undefined ? null : init.data;
      this.origin = init.origin === undefined ? "" : String(init.origin);
      this.lastEventId = init.lastEventId === undefined ? "" : String(init.lastEventId);
      this.source = init.source === undefined ? null : init.source;
      this.ports = init.ports === undefined ? [] : [...init.ports];
    }
    get [Symbol.toStringTag]() { return "MessageEvent"; }
  }
  const listenersOf = new WeakMap();
  class EventTarget {
    constructor() { listenersOf.set(this, new Map()); }
    addEventListener(type, listener, options) {
      if (listener === null || listener === undefined) return;
      const map = listenersOf.get(this);
      const once = typeof options === "object" && options !== null && !!options.once;
      const capture = typeof options === "boolean" ? options : !!(options && options.capture);
      const list = map.get(String(type)) || [];
      if (list.some((entry) => entry.listener === listener && entry.capture === capture)) return;
      list.push({ listener, once, capture });
      map.set(String(type), list);
      if (options && typeof options === "object" && options.signal) {
        options.signal.addEventListener("abort", () => this.removeEventListener(type, listener, options), { once: true });
      }
    }
    removeEventListener(type, listener, options) {
      const map = listenersOf.get(this);
      const capture = typeof options === "boolean" ? options : !!(options && options.capture);
      const list = map.get(String(type));
      if (!list) return;
      const index = list.findIndex((entry) => entry.listener === listener && entry.capture === capture);
      if (index >= 0) list.splice(index, 1);
    }
    dispatchEvent(event) {
      if (!(event instanceof Event)) throw new TypeError("EventTarget.dispatchEvent: argument is not an Event");
      event._setTarget(this);
      const map = listenersOf.get(this);
      const list = map.get(event.type);
      const handler = this["on" + event.type];
      if (typeof handler === "function") handler.call(this, event);
      if (list) {
        for (const entry of [...list]) {
          if (entry.once) this.removeEventListener(event.type, entry.listener, entry.capture);
          if (typeof entry.listener === "function") entry.listener.call(this, event);
          else if (entry.listener && typeof entry.listener.handleEvent === "function") entry.listener.handleEvent(event);
          if (event._immediateStopped) break;
        }
      }
      return !event.defaultPrevented;
    }
    get [Symbol.toStringTag]() { return "EventTarget"; }
  }

  /* ── message ports and channels ──────────────────────────────────── */
  class MessagePort extends EventTarget {
    constructor() { super(); this._queue = []; this._peer = null; this._started = false; this._closed = false; this.onmessage = null; this.onmessageerror = null; }
    postMessage(message) {
      const peer = this._peer;
      if (!peer || peer._closed) return;
      const cloned = global.structuredClone(message);
      peer._queue.push({ message: cloned });
      peer._drain();
    }
    _drain() {
      if (!this._started || this._draining) return;
      this._draining = true;
      global.queueMicrotask(() => {
        this._draining = false;
        while (this._started && !this._closed && this._queue.length > 0) {
          const { message } = this._queue.shift();
          this.dispatchEvent(new MessageEvent("message", { data: message }));
        }
      });
    }
    start() { this._started = true; this._drain(); }
    close() { this._closed = true; this.dispatchEvent(new Event("close")); }
    ref() { return this; }
    unref() { return this; }
    addEventListener(type, listener, options) {
      super.addEventListener(type, listener, options);
      if (type === "message") this.start();
    }
    set onmessage(handler) { this._onmessage = handler; if (handler) this.start(); }
    get onmessage() { return this._onmessage === undefined ? null : this._onmessage; }
    get [Symbol.toStringTag]() { return "MessagePort"; }
  }
  class MessageChannel {
    constructor() {
      this.port1 = new MessagePort();
      this.port2 = new MessagePort();
      this.port1._peer = this.port2;
      this.port2._peer = this.port1;
    }
    get [Symbol.toStringTag]() { return "MessageChannel"; }
  }
  const broadcastChannels = new Map();
  class BroadcastChannel extends EventTarget {
    constructor(name) {
      super();
      this.name = String(name);
      this._closed = false;
      const peers = broadcastChannels.get(this.name) || new Set();
      peers.add(this);
      broadcastChannels.set(this.name, peers);
    }
    postMessage(message) {
      if (this._closed) throw new global.DOMException("BroadcastChannel is closed", "InvalidStateError");
      const cloned = global.structuredClone(message);
      for (const peer of broadcastChannels.get(this.name) || []) {
        if (peer === this || peer._closed) continue;
        global.queueMicrotask(() => peer.dispatchEvent(new MessageEvent("message", { data: cloned })));
      }
    }
    close() { this._closed = true; (broadcastChannels.get(this.name) || new Set()).delete(this); }
    ref() { return this; }
    unref() { return this; }
    get [Symbol.toStringTag]() { return "BroadcastChannel"; }
  }

  /* ── structuredClone ─────────────────────────────────────────────── */
  const structuredClone = (value, options) => {
    const seen = new Map();
    const fail = (what) => {
      throw new global.DOMException(what + " could not be cloned.", "DataCloneError");
    };
    const clone = (v) => {
      if (v === null || typeof v !== "object") {
        if (typeof v === "function") fail(String(v));
        if (typeof v === "symbol") fail(String(v));
        return v;
      }
      if (seen.has(v)) return seen.get(v);
      if (v instanceof Date) { const d = new Date(v.getTime()); seen.set(v, d); return d; }
      if (v instanceof RegExp) { const r = new RegExp(v.source, v.flags); seen.set(v, r); return r; }
      if (v instanceof ArrayBuffer) { const b = v.slice(0); seen.set(v, b); return b; }
      if (ArrayBuffer.isView(v)) {
        const c = new v.constructor(v);
        seen.set(v, c);
        return c;
      }
      if (v instanceof Map) { const m = new Map(); seen.set(v, m); for (const [k, x] of v) m.set(clone(k), clone(x)); return m; }
      if (v instanceof Set) { const s = new Set(); seen.set(v, s); for (const x of v) s.add(clone(x)); return s; }
      if (v instanceof Error) {
        const e = new (global[v.name] || Error)(v.message);
        seen.set(v, e);
        if (v.stack !== undefined) e.stack = v.stack;
        if (v.cause !== undefined) e.cause = clone(v.cause);
        return e;
      }
      if (Array.isArray(v)) { const a = new Array(v.length); seen.set(v, a); for (let i = 0; i < v.length; i += 1) if (i in v) a[i] = clone(v[i]); return a; }
      if (typeof v.then === "function") fail("Promise");
      const proto = Object.getPrototypeOf(v);
      if (proto !== Object.prototype && proto !== null && !(v instanceof Blob)) {
        if (typeof v.constructor === "function" && v.constructor !== Object) {
          const named = v.constructor.name;
          if (named && !(v instanceof Blob)) fail(named + " object");
        }
      }
      const o = {};
      seen.set(v, o);
      for (const key of Object.keys(v)) o[key] = clone(v[key]);
      return o;
    };
    return clone(value);
  };

  /* ── Blob and File ───────────────────────────────────────────────── */
  const encoder = new global.TextEncoder();
  const bytesOfPart = (part) => {
    if (part instanceof Blob) return part._bytes;
    if (part instanceof ArrayBuffer) return new Uint8Array(part.slice(0));
    if (ArrayBuffer.isView(part)) return new Uint8Array(part.buffer.slice(part.byteOffset, part.byteOffset + part.byteLength));
    return encoder.encode(String(part));
  };
  class Blob {
    constructor(parts = [], options = {}) {
      if (parts === null || typeof parts[Symbol.iterator] !== "function") throw new TypeError("Blob constructor: parts must be iterable");
      const chunks = [...parts].map(bytesOfPart);
      const size = chunks.reduce((n, c) => n + c.length, 0);
      const bytes = new Uint8Array(size);
      let offset = 0;
      for (const c of chunks) { bytes.set(c, offset); offset += c.length; }
      this._bytes = bytes;
      const type = options && options.type !== undefined ? String(options.type) : "";
      this._type = /^[\x20-\x7e]*$/.test(type) ? type.toLowerCase() : "";
    }
    get size() { return this._bytes.length; }
    get type() { return this._type; }
    slice(start = 0, end = this.size, type = "") {
      const len = this.size;
      const s = start < 0 ? Math.max(len + start, 0) : Math.min(start, len);
      const e = end < 0 ? Math.max(len + end, 0) : Math.min(end, len);
      const out = new Blob([], { type });
      out._bytes = this._bytes.slice(s, Math.max(s, e));
      return out;
    }
    async text() { return new global.TextDecoder().decode(this._bytes); }
    async arrayBuffer() { return this._bytes.buffer.slice(this._bytes.byteOffset, this._bytes.byteOffset + this._bytes.byteLength); }
    async bytes() { return this._bytes.slice(0); }
    stream() {
      const bytes = this._bytes;
      return new global.ReadableStream({
        pull(controller) { controller.enqueue(bytes.slice(0)); controller.close(); },
      });
    }
    get [Symbol.toStringTag]() { return "Blob"; }
  }
  class File extends Blob {
    constructor(parts, name, options = {}) {
      if (arguments.length < 2) throw new TypeError("File constructor requires 2 arguments");
      super(parts, options);
      this._name = String(name);
      this._lastModified = options && options.lastModified !== undefined ? Number(options.lastModified) : Date.now();
    }
    get name() { return this._name; }
    get lastModified() { return this._lastModified; }
    get webkitRelativePath() { return ""; }
    get [Symbol.toStringTag]() { return "File"; }
  }

  /* ── FormData ────────────────────────────────────────────────────── */
  class FormData {
    #entries = [];
    constructor() {}
    #normalize(value, filename) {
      if (value instanceof Blob) {
        const name = filename !== undefined ? String(filename) : value instanceof File ? value.name : "blob";
        return value instanceof File && filename === undefined ? value : new File([value], name, { type: value.type });
      }
      return String(value);
    }
    append(name, value, filename) { this.#entries.push([String(name), this.#normalize(value, filename)]); }
    set(name, value, filename) {
      const key = String(name);
      const entry = [key, this.#normalize(value, filename)];
      const index = this.#entries.findIndex(([k]) => k === key);
      if (index < 0) { this.#entries.push(entry); return; }
      this.#entries = this.#entries.filter(([k], i) => k !== key || i === index);
      this.#entries[this.#entries.findIndex(([k]) => k === key)] = entry;
    }
    get(name) { const hit = this.#entries.find(([k]) => k === String(name)); return hit ? hit[1] : null; }
    getAll(name) { return this.#entries.filter(([k]) => k === String(name)).map(([, v]) => v); }
    has(name) { return this.#entries.some(([k]) => k === String(name)); }
    delete(name) { this.#entries = this.#entries.filter(([k]) => k !== String(name)); }
    *entries() { for (const [k, v] of this.#entries) yield [k, v]; }
    *keys() { for (const [k] of this.#entries) yield k; }
    *values() { for (const [, v] of this.#entries) yield v; }
    forEach(fn, thisArg) { for (const [k, v] of this.#entries) fn.call(thisArg, v, k, this); }
    [Symbol.iterator]() { return this.entries(); }
    get [Symbol.toStringTag]() { return "FormData"; }
  }

  /* ── performance and navigator ───────────────────────────────────── */
  const hrtimeMs = () => {
    const t = host.hrtime();
    if (Array.isArray(t)) return t[0] * 1e3 + t[1] / 1e6;
    return Number(t);
  };
  const timeOrigin = Date.now() - hrtimeMs();
  const marks = [];
  const performance = {
    timeOrigin,
    now: () => hrtimeMs(),
    mark(name, options) { const entry = { name: String(name), entryType: "mark", startTime: hrtimeMs(), duration: 0, detail: options && options.detail !== undefined ? options.detail : null }; marks.push(entry); return entry; },
    measure(name, startOrOptions, endMark) {
      const find = (n) => marks.filter((m) => m.name === n).pop();
      let start = 0;
      let end = hrtimeMs();
      if (typeof startOrOptions === "string") { const m = find(startOrOptions); if (m) start = m.startTime; }
      else if (startOrOptions && typeof startOrOptions === "object") {
        if (typeof startOrOptions.start === "number") start = startOrOptions.start;
        else if (typeof startOrOptions.start === "string") { const m = find(startOrOptions.start); if (m) start = m.startTime; }
        if (typeof startOrOptions.end === "number") end = startOrOptions.end;
        else if (typeof startOrOptions.end === "string") { const m = find(startOrOptions.end); if (m) end = m.startTime; }
        if (typeof startOrOptions.duration === "number") end = start + startOrOptions.duration;
      }
      if (typeof endMark === "string") { const m = find(endMark); if (m) end = m.startTime; }
      const entry = { name: String(name), entryType: "measure", startTime: start, duration: end - start, detail: null };
      marks.push(entry);
      return entry;
    },
    getEntries: () => [...marks],
    getEntriesByName: (name, type) => marks.filter((m) => m.name === name && (type === undefined || m.entryType === type)),
    getEntriesByType: (type) => marks.filter((m) => m.entryType === type),
    clearMarks(name) { for (let i = marks.length - 1; i >= 0; i -= 1) if (marks[i].entryType === "mark" && (name === undefined || marks[i].name === name)) marks.splice(i, 1); },
    clearMeasures(name) { for (let i = marks.length - 1; i >= 0; i -= 1) if (marks[i].entryType === "measure" && (name === undefined || marks[i].name === name)) marks.splice(i, 1); },
    timerify: (fn) => fn,
    eventLoopUtilization: () => ({ idle: 0, active: 0, utilization: 0 }),
    toJSON() { return { timeOrigin }; },
    get [Symbol.toStringTag]() { return "Performance"; },
  };
  const versions = typeof host.versions === "function" ? host.versions() : {};
  const navigator = {
    userAgent: "Node.js/" + String(versions.node || "24").split(".")[0],
    hardwareConcurrency: 1,
    language: "en-US",
    languages: ["en-US"],
    platform: typeof host.platform === "function" ? host.platform() : "linux",
    get [Symbol.toStringTag]() { return "Navigator"; },
  };

  /* ── streams the base prelude leaves out ─────────────────────────── */
  class WritableStreamDefaultWriter {
    constructor(stream) {
      if (stream._writer) throw new TypeError("WritableStream is locked");
      stream._writer = this;
      this._stream = stream;
      this.closed = new Promise((resolve, reject) => { stream._resolveClosed = resolve; stream._rejectClosed = reject; });
      this.ready = Promise.resolve();
    }
    get desiredSize() { return this._stream._errored ? null : 1; }
    async write(chunk) {
      const stream = this._stream;
      if (stream._errored) throw stream._error;
      if (stream._closed) throw new TypeError("WritableStream is closed");
      const sink = stream._sink;
      try {
        if (typeof sink.write === "function") await sink.write(chunk, stream._controller);
      } catch (error) {
        stream._errored = true; stream._error = error; stream._rejectClosed(error);
        throw error;
      }
    }
    async close() {
      const stream = this._stream;
      if (stream._closed) throw new TypeError("WritableStream is closed");
      stream._closed = true;
      try { if (typeof stream._sink.close === "function") await stream._sink.close(); stream._resolveClosed(undefined); }
      catch (error) { stream._errored = true; stream._error = error; stream._rejectClosed(error); throw error; }
    }
    async abort(reason) {
      const stream = this._stream;
      stream._errored = true; stream._error = reason; stream._closed = true;
      if (typeof stream._sink.abort === "function") await stream._sink.abort(reason);
      stream._rejectClosed(reason);
    }
    releaseLock() { if (this._stream._writer === this) this._stream._writer = null; }
    get [Symbol.toStringTag]() { return "WritableStreamDefaultWriter"; }
  }
  class WritableStream {
    constructor(sink = {}, _strategy) {
      this._sink = sink;
      this._writer = null;
      this._closed = false;
      this._errored = false;
      this._error = undefined;
      this._controller = { error: (e) => { this._errored = true; this._error = e; }, signal: global.AbortSignal ? new global.AbortController().signal : undefined };
      if (typeof sink.start === "function") Promise.resolve(sink.start(this._controller)).catch((e) => { this._errored = true; this._error = e; });
    }
    get locked() { return this._writer !== null; }
    getWriter() { return new WritableStreamDefaultWriter(this); }
    async close() { return new WritableStreamDefaultWriter(this).close(); }
    async abort(reason) { return new WritableStreamDefaultWriter(this).abort(reason); }
    get [Symbol.toStringTag]() { return "WritableStream"; }
  }
  class TextEncoderStream extends global.TransformStream {
    constructor() {
      const enc = new global.TextEncoder();
      super({ transform(chunk, controller) { controller.enqueue(enc.encode(String(chunk))); } });
      this.encoding = "utf-8";
    }
    get [Symbol.toStringTag]() { return "TextEncoderStream"; }
  }
  class CountQueuingStrategy {
    constructor(init) { this.highWaterMark = init && init.highWaterMark !== undefined ? init.highWaterMark : 1; }
    size() { return 1; }
  }
  class ByteLengthQueuingStrategy {
    constructor(init) { this.highWaterMark = init && init.highWaterMark !== undefined ? init.highWaterMark : 1; }
    size(chunk) { return chunk && chunk.byteLength !== undefined ? chunk.byteLength : 1; }
  }
  const unsupportedStream = (name) => class extends global.TransformStream {
    constructor() {
      throw new global.DOMException(name + " is not supported in the scriptc island yet", "NotSupportedError");
    }
  };

  /* ── WebSocket: links, refuses to connect (no socket kernel yet) ── */
  class WebSocket extends EventTarget {
    constructor(url) {
      super();
      throw new global.DOMException("WebSocket (" + String(url) + ") is not supported in the scriptc island yet", "NotSupportedError");
    }
    static get CONNECTING() { return 0; }
    static get OPEN() { return 1; }
    static get CLOSING() { return 2; }
    static get CLOSED() { return 3; }
  }

  define("Event", Event);
  define("CustomEvent", CustomEvent);
  define("ErrorEvent", ErrorEvent);
  define("CloseEvent", CloseEvent);
  define("MessageEvent", MessageEvent);
  define("EventTarget", EventTarget);
  define("MessagePort", MessagePort);
  define("MessageChannel", MessageChannel);
  define("BroadcastChannel", BroadcastChannel);
  define("structuredClone", structuredClone);
  define("Blob", Blob);
  define("File", File);
  define("FormData", FormData);
  define("performance", performance);
  define("navigator", navigator);
  define("WritableStream", WritableStream);
  define("WritableStreamDefaultWriter", WritableStreamDefaultWriter);
  define("TextEncoderStream", TextEncoderStream);
  define("CountQueuingStrategy", CountQueuingStrategy);
  define("ByteLengthQueuingStrategy", ByteLengthQueuingStrategy);
  define("CompressionStream", unsupportedStream("CompressionStream"));
  define("DecompressionStream", unsupportedStream("DecompressionStream"));
  define("WebSocket", WebSocket);
  if (typeof global.ReadableStreamDefaultReader === "undefined" && typeof global.ReadableStream === "function") {
    try {
      const reader = new global.ReadableStream({ pull(c) { c.close(); } }).getReader();
      if (reader && reader.constructor && reader.constructor !== Object) define("ReadableStreamDefaultReader", reader.constructor);
      reader.releaseLock();
    } catch (e) { /* the base prelude's reader stays anonymous */ }
  }
}
