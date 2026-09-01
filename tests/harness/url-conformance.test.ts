/**
 * Version-pinned conformance for the WHATWG URL / URLSearchParams slice.
 *
 * The compatibility profile is compiler input, not test-only metadata: its
 * rows project into the shipped surface manifest. This suite holds the
 * profile to four things:
 *
 *  - the running oracle is the exact Node the census was reflected under;
 *  - the REFLECTED census of URL, URLSearchParams, and the search-params
 *    iterator equals the declared inventory, member for member, setter for
 *    setter — the tripwire that makes a Node upgrade a deliberate profile
 *    edit rather than a silent widening;
 *  - every supported row names differential corpus evidence that exists;
 *  - the shipped manifest carries each row with the status and fence the
 *    profile claims.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import {
  compatEvidenceKey,
  compatRowName,
  compatTargetLabel,
  NODE24_URL_COMPAT_PROFILE,
  type CompatInventoryPlacement,
  type SurfaceManifest,
} from "@scriptc/compiler";
import {
  publicSymbolName,
  reflectInterface,
  wellKnownSymbolNames,
} from "./compat-census.js";

const repoRoot = join(import.meta.dirname, "../..");
const corpusRoot = join(repoRoot, "tests/corpus");
const profile = NODE24_URL_COMPAT_PROFILE;
const inventory = profile.inventory;
const manifest = JSON.parse(
  readFileSync(join(repoRoot, "packages/compiler/surface-manifest.json"), "utf8"),
) as SurfaceManifest;

const membersAt = (owner: string, placement: CompatInventoryPlacement): string[] =>
  inventory.entries
    .filter((entry) => entry.owner === owner && entry.placement === placement)
    .map((entry) => entry.member)
    .sort();

/** Corpus programs carry every suffix the differential runner accepts. */
function corpusExists(name: string): boolean {
  return [".ts", ".mts", ".cjs", ".mjs", ".js"].some((suffix) =>
    existsSync(join(corpusRoot, `${name}${suffix}`)),
  );
}

describe("Node 24 URL compatibility profile", () => {
  test("the running oracle is the exact pinned Node", () => {
    const pinnedNode = readFileSync(join(repoRoot, ".node-version"), "utf8").trim();
    expect(profile.targets.primary.node).toBe(pinnedNode);
    expect(process.versions.node).toBe(profile.targets.primary.node);
    // The version axis exists so a second runtime is a filled slot rather
    // than a schema change; a candidate is only ever added with its own
    // reflected census, so the pinned profile declares none.
    expect(profile.targets.candidates).toEqual([]);
  });

  test("the inventory classifies every supported row and every gap", () => {
    const supported = profile.operations.map((row) => row.id).sort();
    const ids = inventory.entries.map((entry) => entry.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(
      inventory.entries
        .filter((entry) => entry.status === "static")
        .map((entry) => entry.id)
        .sort(),
    ).toEqual(supported);

    for (const entry of inventory.entries) {
      if (entry.status === "static") {
        expect(entry.code, `${entry.id}: static rows have no refusal code`).toBeUndefined();
        expect(entry.reason, `${entry.id}: static rows are explained by evidence`).toBeUndefined();
      } else if (entry.status === "dynamic-only" || entry.status === "unsupported") {
        // The fence is per row: member-shaped refusals raise the stdlib
        // fence, whole-expression refusals raise the syntax fence.
        expect(["SC2020", "SC1090"], `${entry.id}: unexpected fence`).toContain(entry.code);
        expect(entry.reason?.length, `${entry.id}: missing gap rationale`).toBeGreaterThan(0);
      } else {
        expect(entry.code, `${entry.id}: exclusions are not refusal claims`).toBeUndefined();
        expect(entry.reason?.length, `${entry.id}: missing scope rationale`).toBeGreaterThan(0);
      }
    }

    expect(inventory.entries.some((entry) => entry.status === "unsupported")).toBe(true);
    expect(inventory.entries.some((entry) => entry.status === "out-of-scope")).toBe(true);
    expect(inventory.entries.some((entry) => entry.code === "SC1090")).toBe(true);
    expect(inventory.excludedInterfaces.length).toBeGreaterThan(0);
    for (const exclusion of inventory.excludedInterfaces) {
      expect(exclusion.name.length).toBeGreaterThan(0);
      expect(exclusion.reason.length).toBeGreaterThan(0);
    }
  });

  test("the reflected interfaces match the complete public census", () => {
    for (const owner of inventory.interfaces) {
      const source = inventory.sources?.[owner];
      const actual = reflectInterface(owner, source);
      const declaredConstructors = inventory.entries.filter(
        (entry) => entry.owner === owner && entry.placement === "constructor",
      ).length;
      // An interface with no reachable constructor object claims neither a
      // constructor row nor static members.
      expect(declaredConstructors, `${owner}: constructor classification`).toBe(
        source?.prototype === undefined ? 1 : 0,
      );
      expect(actual.statics.sort(), `${owner}: static members`).toEqual(
        membersAt(owner, "static"),
      );
      expect(actual.prototype.sort(), `${owner}: own prototype members`).toEqual(
        membersAt(owner, "prototype"),
      );
      expect(actual.inherited.sort(), `${owner}: inherited prototype members`).toEqual(
        membersAt(owner, "prototype-inherited"),
      );
      expect(actual.symbols.sort(), `${owner}: public symbol members`).toEqual(
        membersAt(owner, "prototype-symbol"),
      );
      expect(actual.setters.sort(), `${owner}: writable components`).toEqual(
        membersAt(owner, "prototype-setter"),
      );
      expect(actual.instance.sort(), `${owner}: own instance properties`).toEqual(
        membersAt(owner, "instance"),
      );
    }
  });

  test("the public-symbol classifier covers every well-known symbol", () => {
    const known = wellKnownSymbolNames();
    expect(known.size).toBeGreaterThan(0);
    for (const [symbol, name] of known) {
      expect(publicSymbolName(symbol)).toBe(name);
    }
    // Node's private transfer/inspection symbols stay out of the census.
    expect(publicSymbolName(Symbol("nodejs.private"))).toBeNull();
  });

  test("the census reaches interfaces that are not globals", () => {
    // The search-params iterator has no global name and no constructor
    // object: without the profile's factory it is unreachable, which is
    // exactly the surface an inventory would otherwise miss.
    const iterator = "URLSearchParams Iterator";
    expect(inventory.interfaces).toContain(iterator);
    expect((globalThis as Record<string, unknown>)[iterator]).toBeUndefined();
    const source = inventory.sources?.[iterator];
    expect(source?.prototype).toBeTypeOf("function");
    expect(reflectInterface(iterator, source).prototype).toEqual(["next"]);
  });

  test("every row has unique ids and resolvable corpus evidence", () => {
    expect(profile.schemaVersion).toBe(1);
    const ids = profile.operations.map((row) => row.id);
    expect(new Set(ids).size).toBe(ids.length);

    for (const row of profile.operations) {
      expect(row.facets.length, `${row.id}: missing facets`).toBeGreaterThan(0);
      expect(row.evidence.length, `${row.id}: missing differential evidence`).toBeGreaterThan(0);
      for (const evidence of row.evidence) {
        const key = compatEvidenceKey(evidence);
        expect(evidence.corpus, `${row.id}: ${key} is not corpus evidence`).toBeDefined();
        expect(corpusExists(evidence.corpus!), `${row.id}: missing ${key}`).toBe(true);
      }
    }
  });

  test("the shipped manifest carries every projected row", () => {
    const entries = new Map(manifest.entries.map((entry) => [entry.id, entry]));
    const target = compatTargetLabel(profile.targets.primary);
    expect(target).toBe(`Node ${profile.targets.primary.node}`);

    for (const operation of profile.operations) {
      const entry = entries.get(operation.id);
      expect(entry, `${operation.id} is missing from the manifest`).toBeDefined();
      expect(entry!.status, `${operation.id}: manifest status`).toBe("static");
      expect(entry!.name).toBe(operation.name);
      expect(entry!.note).toContain(target);
      for (const evidence of operation.evidence) {
        expect(entry!.note).toContain(compatEvidenceKey(evidence));
      }
    }

    for (const row of inventory.entries) {
      const entry = entries.get(row.id);
      if (row.status === "out-of-scope") {
        // Exclusions stay in the profile: the manifest publishes claims,
        // not the deliberate silences behind them.
        expect(entry, `${row.id}: out-of-scope rows are not projected`).toBeUndefined();
        continue;
      }
      if (row.status === "static") continue;
      expect(entry, `${row.id} is missing from the manifest`).toBeDefined();
      expect(entry!.status, `${row.id}: manifest status`).toBe(row.status);
      expect(entry!.code, `${row.id}: manifest fence`).toBe(row.code);
      expect(entry!.name).toBe(compatRowName(row));
      expect(entry!.note).toBe(`${target}; ${row.reason}`);
    }
  });
});
