/**
 * The node:events / EventEmitter compatibility contract.
 *
 * Same shape as the fetch and URL profiles, and the same promise: every
 * public member of the pinned runtime's EventEmitter — the class-value
 * statics, the prototype, and the own properties a constructed instance
 * carries — is classified, so a member the compiler does not lower cannot
 * hide in the gap between an allowlist and the real interface. The
 * conformance suite re-reflects the interface under the pinned Node and
 * fails when the census and this inventory disagree.
 *
 * Three properties of this slice decide most of the statuses below, and
 * each is worth stating before the rows:
 *
 *  - **The module object IS the class.** Node's `node:events` does
 *    `module.exports = EventEmitter`, so the census of the module and the
 *    census of the class are the same object. This profile is therefore
 *    the first to need the schema's `sources.resolve` factory: unlike URL
 *    and Response, EventEmitter is not a global, and the probe reaches it
 *    only through the module. One consequence shows up in the statuses:
 *    the class-value spelling and the module-member spelling of the same
 *    property are DIFFERENT compiler claims, and they do not even split
 *    the same way twice: `EventEmitter.setMaxListeners(n)` lowers while
 *    `events.setMaxListeners(n)` raises SC2020, but `defaultMaxListeners`
 *    is the exact inverse — the module spelling reads and writes, and the
 *    class-value spelling fences. Rows that split carry the surviving
 *    spelling in their `scope`.
 *
 *  - **Compiled emitters are engine-free.** The static tier lowers the
 *    whole 15-member instance surface into native registration/dispatch
 *    (packages/runtime-rust/src/event_emitter.rs), with per-event argument
 *    tuples monomorphized program-wide. The dynamic island carries its own
 *    emulated EventEmitter for island and npm JS — a complete 15-member
 *    class plus once/listenerCount/getEventListeners/setMaxListeners
 *    statics — but that is a DIFFERENT class from a compiled emitter, and
 *    a compiled emitter never exposes the extra members through it. So
 *    members without a lowering are `unsupported`, not `dynamic-only`,
 *    exactly as the URL profile argues for its own emulated class, and
 *    this profile declares NO dynamic-only rows: every member the island
 *    shims is already lowered statically, and every member it does not
 *    shim has no reach from a compiled value either.
 *
 *  - **The internals are public.** Node's EventEmitter is a pre-WebIDL,
 *    pre-private-field class: `_events`, `_eventsCount` and `_maxListeners`
 *    are enumerable own properties of the PROTOTYPE and, after
 *    `EventEmitter.init` runs, of every INSTANCE. That is not a leak the
 *    census should paper over — an empty `instance` set would be a lie
 *    here — so all three are declared at both placements. They are the
 *    reason this profile is the first with a non-empty instance census.
 */

import { EventEmitter } from "node:events";

import {
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
import { NODE_COMPAT_MATRIX } from "./node-matrix.js";

export type EventsCompatFacet =
  | "argument-tuple"
  | "callback-order"
  | "callback-this"
  | "error-shape"
  | "listener-identity"
  | "liveness"
  | "max-listeners"
  | "meta-events"
  | "mutation"
  | "once-consumption"
  | "property-read"
  | "registration-order"
  | "return-value"
  | "snapshot";

export type EventsCompatOperation = CompatOperation<EventsCompatFacet>;

export interface EventsCompatProfile {
  schemaVersion: 1;
  targets: CompatTargets;
  operations: readonly EventsCompatOperation[];
  inventory: CompatInventory;
}

const corpus = compatCorpus;

/** Every fence below was verified by COMPILING a probe and observing the
 * diagnostic, not by reading the lowering, and the census split cleanly
 * in two along a line worth naming:
 *
 *  - a class-value CALL whose name the emitter also carries as an
 *    instance member — once, on, getMaxListeners, listenerCount,
 *    setMaxListeners with two arguments — reaches the emitter lowering,
 *    which recognises the name and refuses the static form with the
 *    stdlib fence SC2020 ("'the static EventEmitter.once form' … has no
 *    scriptc lowering yet");
 *  - a call whose name has no instance counterpart (getEventListeners,
 *    addAbortListener) never reaches that lowering at all and is refused
 *    as an unclaimed call shape, SC1090 ("method calls like
 *    'EventEmitter.getEventListeners' is not supported yet"), and so is
 *    every plain property READ off the class value, plus every read or
 *    write of Node's `_`-prefixed internals ("reading 'usingDomains' from
 *    a value of type 'typeof EventEmitter'" / "assignment to
 *    non-variables").
 *
 * That is the same per-row-not-per-profile fence discipline the URL
 * profile uses for its component writes. */
const { staticEntry, unsupportedEntry, outOfScopeEntry } = compatEntries("SC2020");
const { unsupportedEntry: unsupportedShapeEntry } = compatEntries("SC1090");

const classValueOnly =
  "the class-value statics have no lowering yet; instance emitters lower the same-named member, and the module-member spelling raises the same fence";
const asyncStatic =
  "the promise/async-iterator module functions have no static lowering: neither has an engine-free representation, and the island shim's own EventEmitter is not what a compiled emitter is";
const internalField =
  "Node's pre-private-field internals are public properties of the prototype and of every instance, but nothing in the static tier claims their shapes: the registry behind a compiled emitter is a native structure, not a JS object graph";
const nodeInternalSymbolKey =
  "an internal Node symbol used as a per-target listener-cap key on EventTarget, with no EventEmitter operation behind it and no engine-free representation";

/** The 15 prototype members the static tier lowers, each with the corpus
 * program that pins its behavior against the oracle. Registration and
 * removal share one lowering path but stay separate rows: they are
 * separate members of the reflected interface. */
const emitterOperation = (
  member: string,
  kind: EventsCompatOperation["kind"],
  facets: readonly EventsCompatFacet[],
  evidence: readonly CompatEvidence[],
  scope?: string,
): EventsCompatOperation => ({
  id: `stdlib.events.emitter.${member === "constructor" ? "constructor" : member}`,
  name: member === "constructor" ? "EventEmitter constructor" : `EventEmitter.${member}`,
  kind,
  facets,
  ...(scope !== undefined ? { scope } : {}),
  evidence,
});

/** Publish a class-value row under a name the prototype row cannot
 * collide with. Because Node's module object IS the class, five names —
 * once, on, listenerCount, getMaxListeners, setMaxListeners — sit at both
 * placements, and four of them carry OPPOSITE statuses: publishing both
 * halves as bare `EventEmitter.once` would make the manifest say the same
 * name is static and unsupported at once. */
const classValueRow = (row: CompatInventoryEntry): CompatInventoryEntry => ({
  ...row,
  publishAs: `${row.owner}.${row.member} (static)`,
});

const emitterStatic = (member: string): CompatInventoryEntry =>
  staticEntry(`stdlib.events.emitter.${member}`, "EventEmitter", member, "prototype");

/** The three pre-private-field internals, declared at both placements the
 * runtime exposes them at. */
const INTERNAL_FIELDS = ["_events", "_eventsCount", "_maxListeners"] as const;

/** The literal event-name requirement, shared by every registration and
 * removal row: the lowering monomorphizes one argument tuple per event
 * name program-wide, which needs the name at compile time. */
const LITERAL_NAME =
  "the compile-time string-literal event name; the event's argument tuple is unified program-wide across every emit site and every annotated listener, so a computed or symbol name (EventEmitter.errorMonitor included) is refused per site";

export const NODE24_EVENTS_COMPAT_PROFILE = {
  schemaVersion: 1,
  targets: {
    // The census below was reflected under BOTH runtimes, and the two
    // reflections were identical: EventEmitter's statics, prototype
    // members, the three public internals, and the own properties of a
    // constructed instance are the same on Node 24 and Node 26. So no row
    // here carries a version qualifier — the shared census IS the Node 26
    // census, not an assumption that it carries over.
    ...NODE_COMPAT_MATRIX,
  },
  operations: [
    emitterOperation(
      "constructor",
      "constructor",
      ["argument-tuple"],
      [corpus("1644-ee-basics"), corpus("1645-ee-extends"), corpus("1654-ee-namespace")],
      "the zero-argument form, under every spelling that names the class — `new EventEmitter()` from a named import, `new events.EventEmitter()` through the module namespace, and `class X extends EventEmitter`; the options-object form is refused per site (SC1090, 'EventEmitter constructor options')",
    ),
    emitterOperation(
      "on",
      "method",
      ["registration-order", "argument-tuple", "callback-this", "meta-events", "return-value"],
      [corpus("1644-ee-basics"), corpus("1646-ee-once-remove"), corpus("1761-emitter-special-event-names")],
      `${LITERAL_NAME}; returns the emitter for chaining, and fires 'newListener' before the add`,
    ),
    emitterOperation(
      "addListener",
      "method",
      ["registration-order", "argument-tuple", "meta-events", "return-value"],
      [corpus("1644-ee-basics")],
      "the alias of on, sharing its lowering and its literal-name requirement",
    ),
    emitterOperation(
      "once",
      "method",
      ["registration-order", "once-consumption", "meta-events", "callback-order"],
      [corpus("1646-ee-once-remove"), corpus("1647-ee-meta-events"), corpus("2620-ee-override-once-order")],
      `${LITERAL_NAME}; the registration is consumed by the first emit and its 'removeListener' fires BEFORE the body runs, as in Node`,
    ),
    emitterOperation(
      "prependListener",
      "method",
      ["registration-order", "callback-order", "meta-events"],
      [corpus("1650-ee-prepend"), corpus("2620-ee-override-once-order")],
      `${LITERAL_NAME}; the listener goes to the front of the live list`,
    ),
    emitterOperation(
      "prependOnceListener",
      "method",
      ["registration-order", "callback-order", "once-consumption", "meta-events"],
      [corpus("1650-ee-prepend")],
      `${LITERAL_NAME}; the front-of-list and once-consumption flags combined`,
    ),
    emitterOperation(
      "off",
      "method",
      ["listener-identity", "mutation", "meta-events", "return-value"],
      [corpus("1646-ee-once-remove"), corpus("2623-ee-job-queue")],
      `${LITERAL_NAME}; removes by listener IDENTITY, the LAST matching registration first, and fires 'removeListener' per removal`,
    ),
    emitterOperation(
      "removeListener",
      "method",
      ["listener-identity", "mutation", "meta-events", "return-value"],
      [corpus("1646-ee-once-remove"), corpus("1652-ee-snapshot")],
      "the alias of off, sharing its lowering and its identity-removal order",
    ),
    emitterOperation(
      "removeAllListeners",
      "method",
      ["mutation", "meta-events", "return-value"],
      [corpus("1644-ee-basics"), corpus("1647-ee-meta-events"), corpus("1652-ee-snapshot")],
      "the name-argument and the whole-emitter zero-argument forms; removal is LIFO per name and 'removeListener' is the last event drained, as in Node",
    ),
    emitterOperation(
      "emit",
      "method",
      ["callback-order", "argument-tuple", "liveness", "error-shape", "return-value", "snapshot"],
      [corpus("1644-ee-basics"), corpus("1648-ee-error-event"), corpus("1652-ee-snapshot"), corpus("2618-ee-emit-override")],
      "the literal-name call supplying the event's EXACT unified argument tuple; dispatch walks a snapshot taken at emit time, returns whether any listener ran, and an unhandled 'error' payload throws catchably. The one member a subclass may override, per event name, with `super.emit` chaining",
    ),
    emitterOperation(
      "listenerCount",
      "method",
      ["property-read", "liveness"],
      [corpus("1644-ee-basics"), corpus("1649-ee-names-counts"), corpus("1677-emitter-listeners")],
      "the name-only and the identity-filtering (name, listener) forms, both reading the live list",
    ),
    emitterOperation(
      "listeners",
      "method",
      ["snapshot", "listener-identity"],
      [corpus("1677-emitter-listeners")],
      "the fresh originals array, in list order, for events whose unified argument tuple is EMPTY — the declared element type would otherwise lie about what a pulled-out listener is callable with. Events with arguments, and events carrying any unannotated JS-lane registration, are refused per site",
    ),
    emitterOperation(
      "rawListeners",
      "method",
      ["snapshot", "listener-identity"],
      [corpus("1677-emitter-listeners")],
      "the same empty-tuple restriction as listeners; the once WRAPPER identity is a documented divergence — this returns the original, not Node's wrapper object",
    ),
    emitterOperation(
      "eventNames",
      "method",
      ["property-read", "liveness", "registration-order"],
      [corpus("1647-ee-meta-events"), corpus("1649-ee-names-counts"), corpus("1761-emitter-special-event-names")],
      "the zero-argument call, in first-registration order, with names dropped as their last listener leaves",
    ),
    emitterOperation(
      "setMaxListeners",
      "method",
      ["max-listeners", "mutation", "return-value", "error-shape"],
      [corpus("1651-ee-max-listeners"), corpus("2574-emitter-max-listeners-ladders")],
      "the per-instance cap, returning the emitter for chaining; 0 is unlimited and a negative or non-integer argument throws Node's catchable ERR_OUT_OF_RANGE",
    ),
    emitterOperation(
      "getMaxListeners",
      "method",
      ["max-listeners", "property-read", "liveness"],
      [corpus("1651-ee-max-listeners"), corpus("2574-emitter-max-listeners-ladders")],
      "the per-instance cap when one was set, otherwise a LIVE read of the process-wide default — an emitter pinned before a default change still answers the new default",
    ),
    {
      id: "stdlib.events.static.setMaxListeners",
      name: "EventEmitter.setMaxListeners (static)",
      kind: "static-method",
      facets: ["max-listeners", "mutation", "error-shape"],
      scope:
        "the one-argument number form off the CLASS VALUE, writing the process-wide default after Node's validateNumber; the (n, ...targets) per-target overload is refused, and so is the identical property read off the module binding (`events.setMaxListeners`), which raises the stdlib fence",
      evidence: [corpus("2321-emitter-static-setmax")],
    },
    {
      id: "stdlib.events.static.defaultMaxListeners",
      name: "EventEmitter.defaultMaxListeners",
      kind: "property",
      facets: ["max-listeners", "property-read", "liveness", "mutation"],
      scope:
        "the process-wide default, read and written through the module binding (`events.defaultMaxListeners`); every emitter with no per-instance cap answers the live value",
      evidence: [corpus("2574-emitter-max-listeners-ladders")],
    },
    {
      id: "stdlib.events.static.EventEmitter",
      name: "EventEmitter.EventEmitter",
      kind: "property",
      facets: ["property-read"],
      scope:
        "the class's self-reference, reached through the module-namespace and named-import spellings (`events.EventEmitter`, `import { EventEmitter }`) for construction, `extends`, and `instanceof`; re-reading it off an already-resolved class value has no lowering",
      evidence: [corpus("1654-ee-namespace")],
    },
  ],
  inventory: {
    interfaces: ["EventEmitter"],
    sources: {
      // EventEmitter is not a global: the census reaches the interface
      // only through the module — which, because Node does
      // `module.exports = EventEmitter`, IS the class object. This is the
      // schema's `resolve` factory doing the job it exists for.
      EventEmitter: {
        resolve: () => EventEmitter,
        instance: () => new EventEmitter(),
      },
    },
    entries: [
      staticEntry(
        "stdlib.events.emitter.constructor",
        "EventEmitter",
        "constructor",
        "constructor",
      ),

      // ── the class-value statics ──────────────────────────────────────
      staticEntry(
        "stdlib.events.static.setMaxListeners",
        "EventEmitter",
        "setMaxListeners",
        "static",
      ),
      staticEntry(
        "stdlib.events.static.defaultMaxListeners",
        "EventEmitter",
        "defaultMaxListeners",
        "static",
      ),
      staticEntry(
        "stdlib.events.static.EventEmitter",
        "EventEmitter",
        "EventEmitter",
        "static",
      ),
      // These four names live at BOTH placements — the class value and
      // the prototype — with opposite statuses, so each class-value row
      // publishes under an explicit disambiguated name.
      classValueRow(
        unsupportedEntry(
          "stdlib.events.static.once",
          "EventEmitter",
          "once",
          "static",
          `${asyncStatic}; the instance member of the same name is a different function and does lower`,
        ),
      ),
      classValueRow(
        unsupportedEntry("stdlib.events.static.on", "EventEmitter", "on", "static", asyncStatic),
      ),
      // No instance member shares this name, so the class-value call is
      // refused as an unclaimed call shape rather than as a declared
      // stdlib member with no lowering — the SC1090/SC2020 split above.
      unsupportedShapeEntry(
        "stdlib.events.static.getEventListeners",
        "EventEmitter",
        "getEventListeners",
        "static",
        "no lowering in either tier, and no instance member of the same name to fall back on; the emitter's own listeners()/rawListeners() are the lowered introspection form",
      ),
      classValueRow(
        unsupportedEntry(
          "stdlib.events.static.getMaxListeners",
          "EventEmitter",
          "getMaxListeners",
          "static",
          `${classValueOnly}; emitter.getMaxListeners() is the lowered read`,
        ),
      ),
      classValueRow(
        unsupportedEntry(
          "stdlib.events.static.listenerCount",
          "EventEmitter",
          "listenerCount",
          "static",
          `${classValueOnly}; the deprecated static delegates to emitter.listenerCount(name), which does lower`,
        ),
      ),
      unsupportedShapeEntry(
        "stdlib.events.static.addAbortListener",
        "EventEmitter",
        "addAbortListener",
        "static",
        "AbortSignal listener registration is EventTarget surface reached through the events module, not EventEmitter surface; nothing lowers it and no instance member of the same name catches the call",
      ),
      unsupportedShapeEntry(
        "stdlib.events.static.errorMonitor",
        "EventEmitter",
        "errorMonitor",
        "static",
        "a SYMBOL event name, and event names must be compile-time string literals for the per-event tuple monomorphization; reading the value off the class has no lowering, and passing it as a name is refused at the registration site with the non-literal-name fence",
      ),
      unsupportedShapeEntry(
        "stdlib.events.static.captureRejectionSymbol",
        "EventEmitter",
        "captureRejectionSymbol",
        "static",
        "the captureRejections protocol is not implemented in the static tier — the constructor option is refused with the same fence — so its symbol key has nothing behind it and reading it off the class has no lowering",
      ),
      unsupportedShapeEntry(
        "stdlib.events.static.captureRejections",
        "EventEmitter",
        "captureRejections",
        "static",
        "the process-wide captureRejections switch; the protocol it turns on is not implemented in the static tier, so reading or writing the flag would promise dispatch behavior nothing delivers",
      ),
      unsupportedShapeEntry(
        "stdlib.events.static.usingDomains",
        "EventEmitter",
        "usingDomains",
        "static",
        "the node:domain integration flag; domains are island-only legacy surface, and reading the flag off the class value has no lowering",
      ),
      unsupportedShapeEntry(
        "stdlib.events.static.init",
        "EventEmitter",
        "init",
        "static",
        "the internal initializer Node calls to stamp _events/_eventsCount/_maxListeners onto a foreign object; a compiled emitter's registry is a native structure, so there is nothing to stamp and nothing claims the property read",
      ),
      unsupportedShapeEntry(
        "stdlib.events.static.EventEmitterAsyncResource",
        "EventEmitter",
        "EventEmitterAsyncResource",
        "static",
        "the async_hooks-backed emitter subclass; async_hooks has no static lowering, reading the class off the class value has none either, and its own surface is excluded from this profile rather than censused",
      ),
      // Not refusals but scope statements: these two are Node's internal
      // per-target listener-cap keys on EventTarget, and EventTarget is
      // an excluded interface. An exclusion is not a diagnostic claim, so
      // they carry no fence and are not projected.
      ...["kMaxEventTargetListeners", "kMaxEventTargetListenersWarned"].map((member) =>
        outOfScopeEntry(
          `stdlib.events.static.${member}`,
          "EventEmitter",
          member,
          "static",
          nodeInternalSymbolKey,
        )
      ),

      // ── the prototype: the 15 lowered members ────────────────────────
      ...[
        "on",
        "addListener",
        "once",
        "prependListener",
        "prependOnceListener",
        "off",
        "removeListener",
        "removeAllListeners",
        "emit",
        "listenerCount",
        "listeners",
        "rawListeners",
        "eventNames",
        "setMaxListeners",
        "getMaxListeners",
      ].map(emitterStatic),

      // ── the prototype: Node's pre-private-field internals ────────────
      // Present at BOTH placements, which is the whole point of declaring
      // them: the runtime puts them on the prototype as defaults and on
      // every instance as enumerable own properties.
      ...INTERNAL_FIELDS.map((member) =>
        unsupportedShapeEntry(
          `stdlib.events.emitter.internal.${member}`,
          "EventEmitter",
          member,
          "prototype",
          internalField,
        )
      ),
      ...INTERNAL_FIELDS.map((member) =>
        unsupportedShapeEntry(
          `stdlib.events.emitter.instance.${member}`,
          "EventEmitter",
          member,
          "instance",
          `${internalField}; EventEmitter.init stamps it onto every instance as an enumerable own property, so it is part of the observable instance shape too`,
        )
      ),

    ],
    excludedInterfaces: [
      {
        name: "EventEmitterAsyncResource",
        reason:
          "an async_hooks-backed subclass; its emit/emitDestroy/asyncId/triggerAsyncId/asyncResource surface belongs to an async_hooks profile, not to the EventEmitter census",
      },
      {
        name: "EventTarget / Event / CustomEvent",
        reason:
          "the DOM-style event interfaces the events module also touches (through getEventListeners/setMaxListeners/addAbortListener) are a separate dispatch model with their own inheritance, not EventEmitter members",
      },
      {
        name: "node:events/promises",
        reason:
          "a separate module specifier whose surface is the promise-shaped once/on helpers; it is module surface rather than a member of the class this profile censuses",
      },
      {
        name: "node:stream and the EventEmitter subclasses under it",
        reason:
          "streams inherit this profile's prototype rows but add their own per-class forced event tuples and lifecycle; they are censused as their own slice",
      },
    ],
  },
} satisfies EventsCompatProfile;

/** The registry view of this profile. */
export const EVENTS_COMPAT_PROJECTION: CompatProfileProjection = {
  id: "events",
  targets: NODE24_EVENTS_COMPAT_PROFILE.targets,
  operations: NODE24_EVENTS_COMPAT_PROFILE.operations,
  options: [],
  inventory: NODE24_EVENTS_COMPAT_PROFILE.inventory,
};

/** "Node 24.15.0" — the stamp on every projected row. */
export const EVENTS_COMPAT_TARGET_LABEL = compatTargetLabel(
  NODE24_EVENTS_COMPAT_PROFILE.targets.primary,
);
