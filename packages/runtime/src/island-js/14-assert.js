    /* node:assert (+ assert/strict) — the assertion surface over
     * util's deep-equality machinery, matching Node's codes,
     * operators, and simple generated-message forms (rich diff
     * bodies and call-source introspection are not carried —
     * documented divergence). */
  builtins.assert = memo(() => {
function makeAssert(env) {
  const isDeepStrictEqual = env.isDeepStrictEqual;
  const inspect = env.inspect;
  class AssertionError extends Error {
    constructor(options) {
      const opts = options || {};
      let message = opts.message;
      let generated = false;
      if (message === undefined || message === null) {
        generated = true;
        const a = inspect(opts.actual, { depth: 2 });
        const b = inspect(opts.expected, { depth: 2 });
        switch (opts.operator) {
          case "strictEqual":
            message = "Expected values to be strictly equal:\n\n" + a + " !== " + b + "\n";
            break;
          case "notStrictEqual":
            message = "Expected \"actual\" to be strictly unequal to: " + b;
            break;
          case "deepStrictEqual":
            message = "Expected values to be strictly deep-equal:\n\n" + a + " !== " + b + "\n";
            break;
          case "notDeepStrictEqual":
            message = "Expected \"actual\" not to be strictly deep-equal to:\n\n" + b + "\n";
            break;
          case "==":
            message = "Expected values to be loosely equal:\n\n" + a + " != " + b + "\n";
            break;
          case "!=":
            message = "Expected \"actual\" to be loosely unequal to:\n\n" + b + "\n";
            break;
          case "fail":
            message = "Failed";
            break;
          default:
            message = a + " " + (opts.operator || "==") + " " + b;
        }
      } else if (message instanceof Error) {
        throw message;
      }
      super(String(message));
      this.name = "AssertionError";
      this.code = "ERR_ASSERTION";
      this.actual = opts.actual;
      this.expected = opts.expected;
      this.operator = opts.operator;
      this.generatedMessage = opts.generatedMessage !== undefined ? opts.generatedMessage : generated;
    }
  }
  function fail(actual, expected, message, operator) {
    const argsLen = arguments.length;
    if (argsLen === 0) {
      throw new AssertionError({ message: "Failed", operator: "fail", generatedMessage: true });
    }
    if (argsLen === 1) {
      throw new AssertionError({ message: actual === undefined ? "Failed" : actual, operator: "fail", generatedMessage: actual === undefined });
    }
    if (argsLen === 2) operator = "!=";
    throw new AssertionError({ message, actual, expected, operator: operator || "fail" });
  }
  const innerOk = (value, message) => {
    if (!value) {
      if (message instanceof Error) throw message;
      throw new AssertionError({
        message: message !== undefined ? message
          : "The expression evaluated to a falsy value",
        actual: value,
        expected: true,
        operator: "==",
        generatedMessage: message === undefined,
      });
    }
  };
  function ok(value, message) {
    innerOk(value, message);
  }
  const looseDeep = (a, b, seen) => {
    if (a == b) return true;
    if (typeof a === "number" && typeof b === "number") return Number.isNaN(a) && Number.isNaN(b);
    if (a === null || b === null || typeof a !== "object" || typeof b !== "object") return false;
    const tagA = Object.prototype.toString.call(a);
    if (tagA !== Object.prototype.toString.call(b)) return false;
    if (tagA === "[object Date]") return a.getTime() == b.getTime(); // eslint-disable-line eqeqeq
    if (tagA === "[object RegExp]") return String(a) === String(b);
    seen = seen || new Set();
    const key = null;
    void key;
    if (seen.has(a)) return true;
    seen.add(a);
    if (Array.isArray(a)) {
      if (!Array.isArray(b) || a.length !== b.length) return false;
      for (let i = 0; i < a.length; i++) {
        if (!looseDeep(a[i], b[i], seen)) return false;
      }
      return true;
    }
    if (a instanceof Map) {
      if (a.size !== b.size) return false;
      for (const [k, v] of a) {
        if (!b.has(k) || !looseDeep(v, b.get(k), seen)) return false;
      }
      return true;
    }
    if (a instanceof Set) {
      if (a.size !== b.size) return false;
      for (const v of a) {
        if (!b.has(v)) return false;
      }
      return true;
    }
    const ka = Object.keys(a);
    const kb = Object.keys(b);
    if (ka.length !== kb.length) return false;
    for (const k of ka) {
      if (!Object.prototype.hasOwnProperty.call(b, k)) return false;
      if (!looseDeep(a[k], b[k], seen)) return false;
    }
    return true;
  };
  const checkExpected = (actual, expected, message, fnName) => {
    if (typeof expected === "function") {
      if (expected.prototype !== undefined && actual instanceof expected) return true;
      if (Error.isPrototypeOf ? Object.getPrototypeOf(expected) === null : false) return false;
      if (!(expected === Error || Error.prototype.isPrototypeOf(expected.prototype || {}))) {
        return expected(actual) === true;
      }
      return actual instanceof expected;
    }
    if (expected instanceof RegExp) {
      return expected.test(actual instanceof Error ? actual.message : String(actual));
    }
    if (expected !== null && typeof expected === "object") {
      for (const k of Object.keys(expected)) {
        const want = expected[k];
        const got = actual[k];
        if (want instanceof RegExp) {
          if (!want.test(got)) return false;
        } else if (!isDeepStrictEqual(got, want)) {
          return false;
        }
      }
      return true;
    }
    void message;
    void fnName;
    return false;
  };
  const mismatchError = (thrown, expected, operator) => {
    if (typeof expected === "function" && (expected === Error || Error.prototype.isPrototypeOf(expected.prototype || {}))) {
      return new AssertionError({
        message: 'The error is expected to be an instance of "' + expected.name + '". Received "' + (thrown && thrown.constructor && thrown.constructor.name) + '"\n\nError message:\n\n' + (thrown && thrown.message),
        actual: thrown,
        expected,
        operator,
        generatedMessage: true,
      });
    }
    if (expected instanceof RegExp) {
      return new AssertionError({
        message: "The input did not match the regular expression " + expected + ". Input:\n\n" + inspect(thrown instanceof Error ? String(thrown) : thrown) + "\n",
        actual: thrown,
        expected,
        operator,
        generatedMessage: true,
      });
    }
    return new AssertionError({
      message: "Expected values to be strictly deep-equal:\n+ actual - expected\n",
      actual: thrown,
      expected,
      operator,
      generatedMessage: true,
    });
  };
  const assert = Object.assign(ok, {
    AssertionError,
    ok,
    fail,
    equal(actual, expected, message) {
      if (actual != expected && !(Number.isNaN(actual) && Number.isNaN(expected))) {
        throw new AssertionError({ message, actual, expected, operator: "==" });
      }
    },
    notEqual(actual, expected, message) {
      if (actual == expected || (Number.isNaN(actual) && Number.isNaN(expected))) {
        throw new AssertionError({ message, actual, expected, operator: "!=" });
      }
    },
    strictEqual(actual, expected, message) {
      if (!Object.is(actual, expected)) {
        throw new AssertionError({ message, actual, expected, operator: "strictEqual" });
      }
    },
    notStrictEqual(actual, expected, message) {
      if (Object.is(actual, expected)) {
        throw new AssertionError({ message, actual, expected, operator: "notStrictEqual" });
      }
    },
    deepEqual(actual, expected, message) {
      if (!looseDeep(actual, expected)) {
        throw new AssertionError({ message, actual, expected, operator: "deepEqual" });
      }
    },
    notDeepEqual(actual, expected, message) {
      if (looseDeep(actual, expected)) {
        throw new AssertionError({ message, actual, expected, operator: "notDeepEqual" });
      }
    },
    deepStrictEqual(actual, expected, message) {
      if (!isDeepStrictEqual(actual, expected)) {
        throw new AssertionError({ message, actual, expected, operator: "deepStrictEqual" });
      }
    },
    notDeepStrictEqual(actual, expected, message) {
      if (isDeepStrictEqual(actual, expected)) {
        throw new AssertionError({ message, actual, expected, operator: "notDeepStrictEqual" });
      }
    },
    throws(fn, expected, message) {
      if (typeof expected === "string") {
        message = expected;
        expected = undefined;
      }
      let thrown = null;
      let did = false;
      try {
        fn();
      } catch (e) {
        did = true;
        thrown = e;
      }
      if (!did) {
        throw new AssertionError({
          message: "Missing expected exception" + (message ? ": " + message : "."),
          operator: "throws",
        });
      }
      if (expected !== undefined && !checkExpected(thrown, expected, message, "throws")) {
        throw mismatchError(thrown, expected, "throws");
      }
    },
    doesNotThrow(fn, expected, message) {
      if (typeof expected === "string") {
        message = expected;
        expected = undefined;
      }
      try {
        fn();
      } catch (e) {
        if (expected === undefined || checkExpected(e, expected, message, "doesNotThrow")) {
          throw new AssertionError({
            message: "Got unwanted exception" + (message ? ": " + message : ".") + "\nActual message: \"" + (e && e.message) + "\"",
            operator: "doesNotThrow",
          });
        }
        throw e;
      }
    },
    async rejects(promiseOrFn, expected, message) {
      if (typeof expected === "string") {
        message = expected;
        expected = undefined;
      }
      let rejection = null;
      let did = false;
      try {
        await (typeof promiseOrFn === "function" ? promiseOrFn() : promiseOrFn);
      } catch (e) {
        did = true;
        rejection = e;
      }
      if (!did) {
        throw new AssertionError({
          message: "Missing expected rejection" + (message ? ": " + message : "."),
          operator: "rejects",
        });
      }
      if (expected !== undefined && !checkExpected(rejection, expected, message, "rejects")) {
        throw mismatchError(rejection, expected, "rejects");
      }
    },
    async doesNotReject(promiseOrFn, expected, message) {
      if (typeof expected === "string") {
        message = expected;
        expected = undefined;
      }
      try {
        await (typeof promiseOrFn === "function" ? promiseOrFn() : promiseOrFn);
      } catch (e) {
        if (expected === undefined || checkExpected(e, expected, message, "doesNotReject")) {
          throw new AssertionError({
            message: "Got unwanted rejection" + (message ? ": " + message : ".") + "\nActual message: \"" + (e && e.message) + "\"",
            operator: "doesNotReject",
          });
        }
        throw e;
      }
    },
    match(string, regexp, message) {
      if (!(regexp instanceof RegExp)) {
        const e = new TypeError('The "regexp" argument must be an instance of RegExp. Received ' + (regexp === null ? "null" : "type " + typeof regexp + " ('" + String(regexp) + "')"));
        e.code = "ERR_INVALID_ARG_TYPE";
        throw e;
      }
      if (typeof string !== "string" || !regexp.test(string)) {
        throw new AssertionError({
          message: message !== undefined ? message
            : typeof string !== "string"
              ? 'The "string" argument must be of type string. Received type ' + typeof string + " (" + inspect(string) + ")"
              : "The input did not match the regular expression " + regexp + ". Input:\n\n" + inspect(string) + "\n",
          actual: string,
          expected: regexp,
          operator: "match",
          generatedMessage: message === undefined,
        });
      }
    },
    doesNotMatch(string, regexp, message) {
      if (!(regexp instanceof RegExp)) {
        const e = new TypeError('The "regexp" argument must be an instance of RegExp. Received ' + (regexp === null ? "null" : "type " + typeof regexp + " ('" + String(regexp) + "')"));
        e.code = "ERR_INVALID_ARG_TYPE";
        throw e;
      }
      if (typeof string === "string" && regexp.test(string)) {
        throw new AssertionError({
          message: message !== undefined ? message
            : "The input was expected to not match the regular expression " + regexp + ". Input:\n\n" + inspect(string) + "\n",
          actual: string,
          expected: regexp,
          operator: "doesNotMatch",
          generatedMessage: message === undefined,
        });
      }
    },
    ifError(value) {
      if (value !== null && value !== undefined) {
        const e = new AssertionError({
          message: "ifError got unwanted exception: " + (value instanceof Error && typeof value.message === "string" ? (value.message === "" ? value.constructor.name : value.message) : inspect(value)),
          actual: value,
          expected: null,
          operator: "ifError",
        });
        throw e;
      }
    },
  });
  const strict = Object.assign(
    function strictOk(...args) {
      return ok(...args);
    },
    assert,
    {
      equal: assert.strictEqual,
      notEqual: assert.notStrictEqual,
      deepEqual: assert.deepStrictEqual,
      notDeepEqual: assert.notDeepStrictEqual,
    },
  );
  strict.strict = strict;
  assert.strict = strict;
  return assert;
}
    const u = builtins.util();
    const a = makeAssert({ isDeepStrictEqual: u.isDeepStrictEqual, inspect: u.inspect });
    a.default = a;
    return a;
  });
  builtins['assert/strict'] = memo(() => {
    const s = builtins.assert().strict;
    s.default = s;
    return s;
  });
