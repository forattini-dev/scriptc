/**
 * The WHATWG URL / URLSearchParams compatibility contract.
 *
 * Same shape as the fetch profile and the same promise: every public
 * member of the pinned runtime's URL, URLSearchParams, and search-params
 * iterator surface is classified, so a member the compiler does not lower
 * cannot hide in the gap between an allowlist and the real interface. The
 * conformance suite re-reflects those interfaces under the pinned Node and
 * fails when the census and this inventory disagree.
 *
 * Two properties of this slice are worth stating up front, because they
 * decide most of the statuses below:
 *
 *  - URL values are engine-free: the static tier parses and serializes
 *    them in native code. The dynamic engine carries its own emulated URL
 *    class for island/npm JS, but a compiled URL value never exposes the
 *    extra members through it — so members without a lowering are
 *    `unsupported`, not `dynamic-only`.
 *  - URL components are read-only here. Reads and writes are separate
 *    claims, so each writable component carries its own setter row.
 */

import {
  COMPAT_METADATA_EXCLUSION,
  compatCorpus,
  compatEntries,
  compatTargetLabel,
  type CompatEvidence,
  type CompatInventory,
  type CompatInventoryEntry,
  type CompatOperation,
  type CompatProfileProjection,
  type CompatTargets,
} from "./profile-schema.js";

export type UrlCompatFacet =
  | "argument-evaluation"
  | "callback-order"
  | "callback-this"
  | "error-shape"
  | "identity"
  | "iteration"
  | "liveness"
  | "missing-arguments"
  | "mutation"
  | "parsing"
  | "property-read"
  | "serialization"
  | "webidl-conversion";

export type UrlCompatOperation = CompatOperation<UrlCompatFacet>;

export interface UrlCompatProfile {
  schemaVersion: 1;
  targets: CompatTargets;
  operations: readonly UrlCompatOperation[];
  inventory: CompatInventory;
}

const corpus = compatCorpus;

/** Most URL refusals are stdlib-surface fences (SC2020). Component WRITES
 * are not: nothing claims the assignment, so it is refused as an
 * unsupported expression shape (SC1090, 'assignment to non-variables').
 * The fence code is per row, not per profile. */
const { staticEntry, unsupportedEntry, outOfScopeEntry } = compatEntries("SC2020");
const { unsupportedEntry: unsupportedShapeEntry } = compatEntries("SC1090");

const islandOnly =
  "the emulated URL class inside the dynamic engine serves island and npm JS only; a compiled URL value exposes no lowering for this member in either tier";
const componentWrite =
  "URL components are read-only in the static tier: there is no component-assignment lowering and no native mutation path behind it";
const iteratorHandle =
  "materialized iterator objects are not first-class handles; for-of over the params, or directly over keys()/values()/entries(), is the lowered iteration form";
const iteratorHelpers =
  "the ECMAScript iterator-helper protocol has no static lowering, and the search-params iterator object it would operate on is not a first-class handle either";

/** Every writable URL component under the pinned runtime. Reflected as
 * accessor set functions by the conformance census. */
const URL_SETTERS = [
  "href",
  "protocol",
  "username",
  "password",
  "host",
  "hostname",
  "port",
  "pathname",
  "search",
  "hash",
] as const;

/** Iterator helpers inherited from Iterator.prototype. */
const ITERATOR_HELPERS = [
  "reduce",
  "toArray",
  "forEach",
  "some",
  "every",
  "find",
  "map",
  "filter",
  "take",
  "drop",
  "flatMap",
] as const;

const SEARCH_PARAMS_ITERATOR = "URLSearchParams Iterator";

const urlOperation = (
  member: string,
  kind: UrlCompatOperation["kind"],
  facets: readonly UrlCompatFacet[],
  evidence: readonly CompatEvidence[],
  scope?: string,
): UrlCompatOperation => ({
  id: `stdlib.url.${member === "constructor" ? "constructor" : member}`,
  name: member === "constructor" ? "URL constructor" : `URL.${member}`,
  kind,
  facets,
  ...(scope !== undefined ? { scope } : {}),
  evidence,
});

const paramsOperation = (
  member: string,
  kind: UrlCompatOperation["kind"],
  facets: readonly UrlCompatFacet[],
  evidence: readonly CompatEvidence[],
  scope?: string,
): UrlCompatOperation => ({
  id: `stdlib.url-search-params.${member}`,
  name:
    member === "constructor"
      ? "URLSearchParams constructor"
      : `URLSearchParams.${member}`,
  kind,
  facets,
  ...(scope !== undefined ? { scope } : {}),
  evidence,
});

const paramsStatic = (member: string): CompatInventoryEntry =>
  staticEntry(
    `stdlib.url-search-params.${member}`,
    "URLSearchParams",
    member,
    "prototype",
  );

export const NODE24_URL_COMPAT_PROFILE = {
  schemaVersion: 1,
  targets: {
    // The census below was reflected under this runtime. A second entry
    // arrives only with its own reflected census, never as an assumption.
    primary: { node: "24.15.0" },
    candidates: [],
  },
  operations: [
    urlOperation(
      "constructor",
      "constructor",
      ["parsing", "webidl-conversion", "error-shape", "missing-arguments"],
      [corpus("1355-url-parse"), corpus("2573-fs-url-arg-ladders")],
      "one absolute-URL string argument; the (input, base) relative-resolution overload and the zero-argument form are refused per site, and an unparseable input throws Node's TypeError('Invalid URL')",
    ),
    urlOperation(
      "href",
      "property",
      ["property-read", "serialization"],
      [corpus("1355-url-parse"), corpus("1356-url-file-bridge"), corpus("1794-searchparams-url-live")],
    ),
    urlOperation(
      "protocol",
      "property",
      ["property-read"],
      [corpus("1355-url-parse"), corpus("1611-url-file-bridge-neutral")],
    ),
    urlOperation(
      "host",
      "property",
      ["property-read"],
      [corpus("1557-url-host")],
      "the WHATWG host serialization, including the empty host of opaque-path URLs",
    ),
    urlOperation(
      "hostname",
      "property",
      ["property-read"],
      [corpus("1577-url-hostname"), corpus("1611-url-file-bridge-neutral")],
    ),
    urlOperation(
      "port",
      "property",
      ["property-read"],
      [corpus("2830-url-port")],
      "the digit-string tail of host; the empty string whenever the port is absent or equals the scheme's own default, dropped at parse time so the getter is a verbatim field read",
    ),
    urlOperation(
      "origin",
      "property",
      ["property-read", "serialization"],
      [corpus("2831-url-origin")],
      "the WHATWG tuple origin for the schemes that have one, and the literal string 'null' for file: and every opaque-path scheme; userinfo is never part of it and the default port is already stripped",
    ),
    urlOperation(
      "pathname",
      "property",
      ["property-read"],
      [corpus("1355-url-parse"), corpus("1611-url-file-bridge-neutral")],
    ),
    urlOperation(
      "search",
      "property",
      ["property-read", "liveness"],
      [corpus("1794-searchparams-url-live")],
      "reads the serialization of the URL's live query, including the empty string a bare '?' produces",
    ),
    urlOperation(
      "searchParams",
      "property",
      ["property-read", "identity", "liveness"],
      [corpus("1794-searchparams-url-live")],
      "the live query view, cached so repeated reads of one URL return the same params identity and writes through it are visible in href/search",
    ),
    urlOperation(
      "hash",
      "property",
      ["property-read"],
      [corpus("2832-url-hash")],
      "'#' + fragment, but the empty string for both no fragment at all and a bare '#'; the fragment runs to the end of the input",
    ),
    urlOperation(
      "username",
      "property",
      ["property-read"],
      [corpus("2833-url-userinfo")],
      "the percent-encoded userinfo component before the first ':', the empty string when absent",
    ),
    urlOperation(
      "password",
      "property",
      ["property-read"],
      [corpus("2833-url-userinfo")],
      "the percent-encoded userinfo component after the first ':', the empty string when absent or empty, with no null/empty distinction",
    ),
    urlOperation(
      "toString",
      "method",
      ["serialization"],
      [corpus("1355-url-parse")],
      "the zero-argument call, equal to href; the method value itself is not a first-class handle",
    ),
    {
      id: "stdlib.url.static.canParse",
      name: "URL.canParse",
      kind: "static-method",
      facets: ["parsing", "webidl-conversion", "error-shape"],
      scope: "the one-argument form; the input's accept/reject decision as a boolean, never throwing — the (input, base) relative-resolution overload is refused",
      evidence: [corpus("2834-url-can-parse")],
    },

    paramsOperation(
      "constructor",
      "constructor",
      ["parsing", "webidl-conversion", "error-shape", "identity"],
      [corpus("1791-searchparams-core"), corpus("1794-searchparams-url-live")],
      "one init argument: omitted/undefined, an application/x-www-form-urlencoded string (one leading '?' stripped), a string[][] pair list, another URLSearchParams (snapshot copy, not an alias), or an inline object literal with literal keys",
    ),
    paramsOperation(
      "size",
      "property",
      ["property-read", "liveness"],
      [corpus("1791-searchparams-core"), corpus("1792-searchparams-encoding")],
    ),
    paramsOperation(
      "append",
      "method",
      ["webidl-conversion", "mutation", "missing-arguments", "error-shape"],
      [
        corpus("1791-searchparams-core"),
        corpus("1792-searchparams-encoding"),
        corpus("2571-searchparams-arg-validation"),
      ],
      "the two-argument call; non-string arguments follow Node's ToString conversion and the missing-argument and Symbol-conversion throws are reproduced",
    ),
    paramsOperation(
      "delete",
      "method",
      ["webidl-conversion", "mutation", "missing-arguments"],
      [corpus("1791-searchparams-core"), corpus("1793-searchparams-iteration")],
      "the name-only and the value-aware two-argument forms as separate call shapes; a 'string | undefined' value argument is narrowed to one of them first",
    ),
    paramsOperation(
      "get",
      "method",
      ["webidl-conversion", "property-read", "missing-arguments"],
      [corpus("1791-searchparams-core"), corpus("1792-searchparams-encoding")],
      "the one-argument call, returning string | null",
    ),
    paramsOperation(
      "getAll",
      "method",
      ["webidl-conversion", "property-read", "missing-arguments"],
      [corpus("1791-searchparams-core")],
      "the one-argument call, returning the values in insertion order",
    ),
    paramsOperation(
      "has",
      "method",
      ["webidl-conversion", "property-read", "missing-arguments"],
      [corpus("1791-searchparams-core")],
      "the name-only and the value-aware two-argument forms as separate call shapes",
    ),
    paramsOperation(
      "set",
      "method",
      ["webidl-conversion", "mutation", "missing-arguments"],
      [corpus("1791-searchparams-core"), corpus("1794-searchparams-url-live")],
      "the two-argument call, replacing the first match in place and dropping the rest",
    ),
    paramsOperation(
      "sort",
      "method",
      ["mutation"],
      [corpus("1791-searchparams-core"), corpus("1792-searchparams-encoding")],
      "the zero-argument call, with WHATWG code-unit ordering and stable pairs",
    ),
    paramsOperation(
      "toString",
      "method",
      ["serialization"],
      [corpus("1791-searchparams-core"), corpus("1792-searchparams-encoding")],
      "the zero-argument call; the method value itself is not a first-class handle",
    ),
    paramsOperation(
      "forEach",
      "method",
      ["callback-order", "callback-this", "liveness", "mutation"],
      [corpus("1792-searchparams-encoding"), corpus("1793-searchparams-iteration")],
      "the one-callback call at one, two, or three parameters, walking the live list so mutations during the walk are observed",
    ),
    ...["entries", "keys", "values"].map((member) =>
      paramsOperation(
        member,
        "method",
        ["iteration", "liveness"],
        [corpus("1793-searchparams-iteration")],
        `the direct for-of head \`for (const x of params.${member}())\`; the iterator object itself is not a first-class handle`,
      )
    ),
    {
      id: "stdlib.url-search-params.symbol.iterator",
      name: "URLSearchParams.[Symbol.iterator]",
      kind: "method",
      facets: ["iteration", "liveness"],
      scope:
        "for-of over the params object, yielding live [name, value] pairs; the explicit params[Symbol.iterator]() spelling is refused",
      evidence: [corpus("1793-searchparams-iteration")],
    },
  ],
  inventory: {
    interfaces: ["URL", "URLSearchParams", SEARCH_PARAMS_ITERATOR],
    sources: {
      // The search-params iterator has no constructor object and no
      // global name: its prototype is reachable only from a live
      // iterator, so the census resolves it through this factory. URL and
      // URLSearchParams are globals and need none.
      [SEARCH_PARAMS_ITERATOR]: {
        prototype: () =>
          Object.getPrototypeOf(new URLSearchParams("a=1")[Symbol.iterator]()) as object,
      },
      URL: { instance: () => new URL("https://user:pw@example.com:8443/a/b?x=1#f") },
      URLSearchParams: { instance: () => new URLSearchParams("a=1&b=2") },
    },
    entries: [
      staticEntry("stdlib.url.constructor", "URL", "constructor", "constructor"),
      unsupportedEntry(
        "stdlib.url.static.parse",
        "URL",
        "parse",
        "static",
        "parse has no compiler lowering in either tier — neither the one-argument form nor the (input, base) form; parse an absolute string with new URL and catch the TypeError instead",
      ),
      staticEntry("stdlib.url.static.canParse", "URL", "canParse", "static"),
      unsupportedEntry(
        "stdlib.url.static.createObjectURL",
        "URL",
        "createObjectURL",
        "static",
        "the Blob URL store has no engine-free representation; Blob itself is outside this slice",
      ),
      unsupportedEntry(
        "stdlib.url.static.revokeObjectURL",
        "URL",
        "revokeObjectURL",
        "static",
        "the Blob URL store has no engine-free representation; only Node's zero-argument ERR_MISSING_ARGS throw is reproduced, which is a refusal parity detail rather than support",
      ),
      staticEntry("stdlib.url.toString", "URL", "toString", "prototype"),
      staticEntry("stdlib.url.href", "URL", "href", "prototype"),
      staticEntry("stdlib.url.origin", "URL", "origin", "prototype"),
      staticEntry("stdlib.url.protocol", "URL", "protocol", "prototype"),
      ...["username", "password", "port", "hash"].map((member) =>
        staticEntry(`stdlib.url.${member}`, "URL", member, "prototype")
      ),
      staticEntry("stdlib.url.host", "URL", "host", "prototype"),
      staticEntry("stdlib.url.hostname", "URL", "hostname", "prototype"),
      staticEntry("stdlib.url.pathname", "URL", "pathname", "prototype"),
      staticEntry("stdlib.url.setter.pathname", "URL", "pathname", "prototype-setter"),
      staticEntry("stdlib.url.search", "URL", "search", "prototype"),
      staticEntry("stdlib.url.searchParams", "URL", "searchParams", "prototype"),
      unsupportedEntry("stdlib.url.toJSON", "URL", "toJSON", "prototype", islandOnly),
      ...URL_SETTERS.filter((member) => member !== "pathname").map((member) =>
        unsupportedShapeEntry(
          `stdlib.url.setter.${member}`,
          "URL",
          member,
          "prototype-setter",
          componentWrite,
        )
      ),
      outOfScopeEntry(
        "stdlib.url.symbol.toStringTag",
        "URL",
        "[Symbol.toStringTag]",
        "prototype-symbol",
        COMPAT_METADATA_EXCLUSION,
      ),

      staticEntry(
        "stdlib.url-search-params.constructor",
        "URLSearchParams",
        "constructor",
        "constructor",
      ),
      ...[
        "size",
        "append",
        "delete",
        "get",
        "getAll",
        "has",
        "set",
        "sort",
        "entries",
        "forEach",
        "keys",
        "values",
        "toString",
      ].map(paramsStatic),
      staticEntry(
        "stdlib.url-search-params.symbol.iterator",
        "URLSearchParams",
        "[Symbol.iterator]",
        "prototype-symbol",
      ),
      outOfScopeEntry(
        "stdlib.url-search-params.symbol.toStringTag",
        "URLSearchParams",
        "[Symbol.toStringTag]",
        "prototype-symbol",
        COMPAT_METADATA_EXCLUSION,
      ),

      unsupportedEntry(
        "stdlib.url-search-params-iterator.next",
        SEARCH_PARAMS_ITERATOR,
        "next",
        "prototype",
        iteratorHandle,
      ),
      ...ITERATOR_HELPERS.map((member) =>
        unsupportedEntry(
          `stdlib.url-search-params-iterator.${member}`,
          SEARCH_PARAMS_ITERATOR,
          member,
          "prototype-inherited",
          iteratorHelpers,
        )
      ),
      unsupportedEntry(
        "stdlib.url-search-params-iterator.symbol.iterator",
        SEARCH_PARAMS_ITERATOR,
        "[Symbol.iterator]",
        "prototype-symbol",
        iteratorHandle,
      ),
      unsupportedEntry(
        "stdlib.url-search-params-iterator.symbol.dispose",
        SEARCH_PARAMS_ITERATOR,
        "[Symbol.dispose]",
        "prototype-symbol",
        "explicit resource management has no static lowering",
      ),
      outOfScopeEntry(
        "stdlib.url-search-params-iterator.symbol.toStringTag",
        SEARCH_PARAMS_ITERATOR,
        "[Symbol.toStringTag]",
        "prototype-symbol",
        COMPAT_METADATA_EXCLUSION,
      ),
    ],
    excludedInterfaces: [
      {
        name: "URLPattern",
        reason: "a separate pattern-matching API, not URL parsing or query manipulation",
      },
      {
        name: "node:url legacy API (url.parse/format/resolve, Url)",
        reason: "the legacy string API is node-builtin module surface, projected under node-builtin.url rather than as WHATWG class rows",
      },
      {
        name: "url.domainToASCII/domainToUnicode/urlToHttpOptions",
        reason: "module-level helpers rather than members of the URL classes this profile censuses",
      },
      {
        name: "Blob",
        reason: "the object-URL store has no engine-free representation; the fetch profile excludes Blob for the same reason",
      },
    ],
  },
} satisfies UrlCompatProfile;

/** The registry view of this profile. */
export const URL_COMPAT_PROJECTION: CompatProfileProjection = {
  id: "url",
  targets: NODE24_URL_COMPAT_PROFILE.targets,
  operations: NODE24_URL_COMPAT_PROFILE.operations,
  options: [],
  inventory: NODE24_URL_COMPAT_PROFILE.inventory,
};

/** "Node 24.15.0" — the stamp on every projected row. */
export const URL_COMPAT_TARGET_LABEL = compatTargetLabel(
  NODE24_URL_COMPAT_PROFILE.targets.primary,
);
