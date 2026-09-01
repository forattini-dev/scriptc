import { expect, test } from "vitest";
import { NODE_COMPAT_MATRIX, compatTargetList } from "@scriptc/compiler";
import {
  nodeOracleExecutable,
  oracleCacheKeyBase,
  oracleEnvironmentFingerprint,
} from "./oracle-environment.js";
import {
  interpreterVersion,
  matrixExecutableVariable,
  primaryOracleExecutable,
  resolveMatrixExecutable,
} from "./node-matrix.js";

test("Node oracle defaults to the test host executable", () => {
  expect(nodeOracleExecutable({}, "/opt/node-host/bin/node")).toBe("/opt/node-host/bin/node");
});

test("Node oracle can differ from the test host executable", () => {
  expect(
    nodeOracleExecutable(
      { SCRIPTC_NODE_ORACLE: "/opt/node24/bin/node" },
      "/opt/node26/bin/node",
    ),
  ).toBe("/opt/node24/bin/node");
});

test("empty Node oracle override keeps the test host executable", () => {
  expect(
    nodeOracleExecutable({ SCRIPTC_NODE_ORACLE: "" }, "/opt/node-host/bin/node"),
  ).toBe("/opt/node-host/bin/node");
});

test("oracle environment fingerprint covers arbitrary output-affecting variables", () => {
  const base = oracleEnvironmentFingerprint({ NODE_ENV: "development", SCRIPTC_NEVER: "no" });

  expect(oracleEnvironmentFingerprint({ NODE_ENV: "production", SCRIPTC_NEVER: "no" })).not.toBe(base);
  expect(oracleEnvironmentFingerprint({ NODE_ENV: "development", SCRIPTC_NEVER: "yes" })).not.toBe(base);
  expect(oracleEnvironmentFingerprint({ NODE_ENV: "development", SCRIPTC_NEVER: "no", EXTRA: "value" })).not.toBe(base);
});

test("oracle environment fingerprint is independent of insertion order", () => {
  expect(oracleEnvironmentFingerprint({ NODE_ENV: "production", PATH: "/bin", EMPTY: "" })).toBe(
    oracleEnvironmentFingerprint({ EMPTY: "", PATH: "/bin", NODE_ENV: "production" }),
  );
});

test("oracle environment fingerprint distinguishes missing, unset, and empty variables", () => {
  expect(oracleEnvironmentFingerprint({})).not.toBe(oracleEnvironmentFingerprint({ VALUE: undefined }));
  expect(oracleEnvironmentFingerprint({ VALUE: undefined })).not.toBe(
    oracleEnvironmentFingerprint({ VALUE: "" }),
  );
});

test("oracle environment fingerprint length-frames keys and values", () => {
  expect(oracleEnvironmentFingerprint({ "A:B": "C;D" })).not.toBe(
    oracleEnvironmentFingerprint({ A: "B:C;D" }),
  );
});

test("oracle cache key invalidates when corpus output-affecting variables change", () => {
  const inputs = {
    nodeVersion: "v24.0.0",
    typescriptVersion: "5.9.0",
    comptimeShim: "comptime",
    islandShim: "island",
    transformTypesHook: "transform-types",
    cwd: "/repo",
  };
  const base = oracleCacheKeyBase({
    ...inputs,
    environment: { NODE_ENV: "development", SCRIPTC_NEVER: "no" },
  });

  expect(oracleCacheKeyBase({ ...inputs, environment: { NODE_ENV: "production", SCRIPTC_NEVER: "no" } })).not.toBe(base);
  expect(oracleCacheKeyBase({ ...inputs, environment: { NODE_ENV: "development", SCRIPTC_NEVER: "yes" } })).not.toBe(base);
});

test("oracle cache key invalidates when the transform-types hook changes", () => {
  const inputs = {
    nodeVersion: "v26.0.0",
    typescriptVersion: "5.9.0",
    comptimeShim: "comptime",
    islandShim: "island",
    environment: {},
    cwd: "/repo",
  };
  expect(oracleCacheKeyBase({ ...inputs, transformTypesHook: "first" })).not.toBe(
    oracleCacheKeyBase({ ...inputs, transformTypesHook: "second" }),
  );
});

// ── the compat matrix: host vs oracle ───────────────────────────────────
// The matrix makes the host/oracle split load-bearing rather than
// theoretical. These pin the two halves of it.

test("oracle cache key separates the two matrix majors", () => {
  // The cached verdict is Node's answer for a program, and the two majors
  // do not always give the same answer (Node 26 rewords AbortSignal.any's
  // ERR_INVALID_ARG_TYPE). A key that collided across majors would serve
  // one major's recorded stdout to the other and call it parity.
  const inputs = {
    typescriptVersion: "5.9.0",
    comptimeShim: "comptime",
    islandShim: "island",
    transformTypesHook: "transform-types",
    environment: {},
    cwd: "/repo",
  };
  const [primary, candidate] = compatTargetList(NODE_COMPAT_MATRIX);
  expect(primary!.node).not.toBe(candidate!.node);
  expect(oracleCacheKeyBase({ ...inputs, nodeVersion: `v${primary!.node}` })).not.toBe(
    oracleCacheKeyBase({ ...inputs, nodeVersion: `v${candidate!.node}` }),
  );
  // Down to a patch, not just a major: a rewording can land in either.
  expect(oracleCacheKeyBase({ ...inputs, nodeVersion: "v26.8.1" })).not.toBe(
    oracleCacheKeyBase({ ...inputs, nodeVersion: "v26.8.0" }),
  );
});

test("every matrix target resolves to an interpreter of that exact version", () => {
  // The gate's whole claim is that each lane ran under the runtime it says
  // it did. Resolution therefore VERIFIES rather than trusts a path — this
  // is what catches a moved mise symlink.
  for (const target of compatTargetList(NODE_COMPAT_MATRIX)) {
    const executable = resolveMatrixExecutable(target);
    expect(interpreterVersion(executable), `${target.id}: ${executable}`).toBe(target.node);
  }
});

test("a wrong-version target override is an error, not a silent fallback", () => {
  const [primary, candidate] = compatTargetList(NODE_COMPAT_MATRIX);
  const wrong = resolveMatrixExecutable(candidate!);
  expect(() =>
    resolveMatrixExecutable(primary!, { [matrixExecutableVariable(primary!)]: wrong }),
  ).toThrow(/reports Node/);
});

test("the differential oracle is the matrix primary, not the host", () => {
  // The census follows the host; the semantic oracle does not. Under the
  // Node 26 lane this is the line that keeps the fetch differential
  // comparing against the one Node whose behavior the native runtime
  // reproduces.
  const [primary] = compatTargetList(NODE_COMPAT_MATRIX);
  expect(interpreterVersion(primaryOracleExecutable(NODE_COMPAT_MATRIX, {}))).toBe(
    primary!.node,
  );
  // An explicit override still wins: that is how you go looking for a
  // divergence on purpose.
  expect(
    primaryOracleExecutable(NODE_COMPAT_MATRIX, {
      SCRIPTC_NODE_ORACLE: "/opt/node26/bin/node",
    }),
  ).toBe("/opt/node26/bin/node");
});
