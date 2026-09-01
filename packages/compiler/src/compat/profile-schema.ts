/**
 * The shared algebra behind every builtin-class compatibility profile.
 *
 * A compat profile is data, not code: it names the pinned runtime it was
 * censused under, the operations the static tier compiles, and — the part
 * that makes the claim falsifiable — a REFLECTED inventory of the whole
 * public surface of the interfaces it touches, with every member
 * classified. A conformance suite re-reflects the runtime and fails when
 * the census and the declared inventory disagree, so a Node upgrade that
 * adds or moves a member is a deliberate profile edit rather than a silent
 * widening of an unaudited surface.
 *
 * Keep this module free of runtime behavior: it holds the row types, the
 * entry constructors, and the evidence helpers that fetch-profile.ts,
 * url-profile.ts, and the surface-manifest projection all consume.
 */

/** The diagnostic a refused row is fenced with. Each profile picks the
 * fence its own surface raises — the stdlib fence (SC2020), the dynamic
 * island fence (SC2012), and so on — instead of one hardcoded code. */
export type CompatFenceCode = `SC${string}`;

export interface CompatEvidence {
  /** Stable scenario id interpreted by a generated differential harness. */
  generated?: string;
  /** Fixture directory below the profile's own evidence root. */
  fixture?: string;
  /** Differential corpus program under tests/corpus (basename, no suffix). */
  corpus?: string;
}

/** Exactly one evidence source per row, rendered as its manifest key. */
export function compatEvidenceKey(evidence: CompatEvidence): string {
  const sources = [
    evidence.generated !== undefined ? `generated:${evidence.generated}` : null,
    evidence.fixture !== undefined ? `fixture:${evidence.fixture}` : null,
    evidence.corpus !== undefined ? `corpus:${evidence.corpus}` : null,
  ].filter((key): key is string => key !== null);
  if (sources.length !== 1) {
    throw new Error("compat profile evidence must name exactly one source");
  }
  return sources[0]!;
}

export interface CompatOperation<Facet extends string = string> {
  id: string;
  name: string;
  kind: "constructor" | "function" | "method" | "property" | "static-method";
  facets: readonly Facet[];
  /** The supported call/input subset when the operation is not an entire
   * WebIDL overload family. The manifest publishes this verbatim. */
  scope?: string;
  evidence: readonly CompatEvidence[];
}

/** One WebIDL dictionary member, named by the conversion it performs. */
export interface CompatOption {
  id: string;
  name: string;
  conversion: string;
  evidence: readonly CompatEvidence[];
}

export type CompatInventoryStatus =
  | "static"
  | "dynamic-only"
  | "unsupported"
  | "out-of-scope";

export type CompatInventoryPlacement =
  | "global"
  | "constructor"
  | "static"
  | "prototype"
  | "prototype-inherited"
  | "prototype-symbol"
  /** The write half of a prototype accessor. Reads and writes are separate
   * compiler claims — a component a runtime makes writable is a new
   * mutation surface, not a wider read — so they are separate rows. */
  | "prototype-setter"
  /** An own property of a constructed instance rather than the prototype.
   * Usually empty for WebIDL classes — an empty declared set is exactly
   * what makes a runtime that starts stamping own properties visible. */
  | "instance"
  | "dictionary";

/** One public property in the pinned runtime census, or one WebIDL
 * dictionary member observed through its conversion reads. Static rows
 * must resolve to an operation/option above; dynamic-only rows are the
 * implementation queue; out-of-scope rows make intentional omissions
 * explicit instead of letting absence masquerade as a support claim. */
export interface CompatInventoryEntry {
  id: string;
  owner: string;
  member: string;
  placement: CompatInventoryPlacement;
  status: CompatInventoryStatus;
  code?: CompatFenceCode;
  reason?: string;
  /** The published name, when owner + placement cannot disambiguate one.
   * Normally placement does the work — a setter row says "(setter)", an
   * instance row says "(instance)". But an interface whose MODULE OBJECT
   * IS the class (Node's `module.exports = EventEmitter`) carries the
   * same name as a class-value static and as a prototype member, with
   * different compiler claims behind each; without an override the two
   * rows would publish under one name and opposite statuses. */
  publishAs?: string;
}

export interface CompatInventoryExclusion {
  name: string;
  reason: string;
}

/** How a conformance probe reaches an interface it must reflect. A global
 * constructor needs nothing; anything else — a class reachable only
 * through a module export, or an iterator prototype with no constructor
 * object at all — names the factory that produces it. */
export interface CompatInterfaceSource {
  /** The interface object itself, e.g. `() => require("node:x").Y`. Named
   * `resolve` rather than `constructor`, which every object literal
   * already inherits from Object.prototype. */
  resolve?: () => unknown;
  /** The prototype, for interfaces with no reachable constructor object
   * (iterator results, internal bridges). */
  prototype?: () => unknown;
  /** A representative instance, reflected for `instance`-placement rows. */
  instance?: () => unknown;
}

export interface CompatInventory {
  /** Interfaces whose own/public inherited surface is reflected. */
  interfaces: readonly string[];
  /** How to reach an interface that is not a global of the same name, and
   * how to obtain an instance. Interfaces absent here are globals. */
  sources?: Readonly<Record<string, CompatInterfaceSource>>;
  /** Public member and WebIDL dictionary census, in oracle order. */
  entries: readonly CompatInventoryEntry[];
  /** Adjacent APIs deliberately outside this profile's slice. */
  excludedInterfaces: readonly CompatInventoryExclusion[];
}

/** One pinned runtime the profile can be censused against. Node's version
 * is the axis; `components` pins whatever else is behaviorally observable
 * (the bundled Undici build, an ICU level). */
export interface CompatRuntimeTarget {
  node: string;
  components?: Readonly<Record<string, string>>;
}

/** The version axis. `primary` is the runtime this profile's inventory was
 * reflected under and the only one its conformance suite asserts;
 * `candidates` names runtimes a future census must cover, so adding
 * Node 26 is a filled-in slot rather than a new schema. */
export interface CompatTargets {
  primary: CompatRuntimeTarget;
  candidates: readonly CompatRuntimeTarget[];
}

/** Human-readable target stamp for manifest notes: "Node X / Undici Y". */
export function compatTargetLabel(target: CompatRuntimeTarget): string {
  const components = Object.entries(target.components ?? {}).map(
    ([name, version]) => `${name[0]!.toUpperCase()}${name.slice(1)} ${version}`,
  );
  return [`Node ${target.node}`, ...components].join(" / ");
}

/** The profile shape the manifest projection and the registry consume.
 * Individual profiles keep their own extra tables (member allowlists,
 * dictionary groups) and expose this view of themselves. */
export interface CompatProfileProjection {
  /** Stable profile id, the registry key ("fetch", "url"). */
  id: string;
  targets: CompatTargets;
  operations: readonly CompatOperation[];
  /** WebIDL dictionary members, all groups concatenated. */
  options: readonly CompatOption[];
  inventory: CompatInventory;
}

/** The human-readable name a census row is published under. Placement
 * decides the spelling: a constructor row names the interface, a global
 * row names the bare global, a setter row says so, everything else is
 * owner-dotted. */
export function compatRowName(row: CompatInventoryEntry): string {
  if (row.publishAs !== undefined) return row.publishAs;
  switch (row.placement) {
    case "constructor":
      return `${row.owner} constructor`;
    case "global":
      return row.owner === "globalThis" ? row.member : `${row.owner}.${row.member}`;
    case "prototype-setter":
      return `${row.owner}.${row.member} (setter)`;
    // An own property of a constructed instance is a separate claim from
    // the prototype property of the same name — a pre-private-field class
    // carries both — so the two rows publish under distinct names.
    case "instance":
      return `${row.owner}.${row.member} (instance)`;
    default:
      return `${row.owner}.${row.member}`;
  }
}

export const compatGenerated = (scenario: string): CompatEvidence => ({
  generated: scenario,
});
export const compatFixture = (name: string): CompatEvidence => ({ fixture: name });
export const compatCorpus = (name: string): CompatEvidence => ({ corpus: name });

/** Symbol rows that are brand metadata rather than callable surface: the
 * same exclusion in every WebIDL profile. */
export const COMPAT_METADATA_EXCLUSION =
  "WebIDL brand metadata is observable reflection, not an executable compatibility operation";

export interface CompatEntryFactories {
  staticEntry(
    id: string,
    owner: string,
    member: string,
    placement: CompatInventoryPlacement,
  ): CompatInventoryEntry;
  dynamicEntry(
    id: string,
    owner: string,
    member: string,
    placement: CompatInventoryPlacement,
    reason: string,
  ): CompatInventoryEntry;
  unsupportedEntry(
    id: string,
    owner: string,
    member: string,
    placement: CompatInventoryPlacement,
    reason: string,
  ): CompatInventoryEntry;
  outOfScopeEntry(
    id: string,
    owner: string,
    member: string,
    placement: CompatInventoryPlacement,
    reason: string,
  ): CompatInventoryEntry;
}

/** The four inventory constructors, bound to the fence a given profile's
 * refusals carry. Static rows never take a code (they are not refusals)
 * and out-of-scope rows never take one either (an exclusion is a scope
 * statement, not a diagnostic claim). */
export function compatEntries(code: CompatFenceCode): CompatEntryFactories {
  return {
    staticEntry: (id, owner, member, placement) => ({
      id,
      owner,
      member,
      placement,
      status: "static",
    }),
    dynamicEntry: (id, owner, member, placement, reason) => ({
      id,
      owner,
      member,
      placement,
      status: "dynamic-only",
      code,
      reason,
    }),
    unsupportedEntry: (id, owner, member, placement, reason) => ({
      id,
      owner,
      member,
      placement,
      status: "unsupported",
      code,
      reason,
    }),
    outOfScopeEntry: (id, owner, member, placement, reason) => ({
      id,
      owner,
      member,
      placement,
      status: "out-of-scope",
      reason,
    }),
  };
}
