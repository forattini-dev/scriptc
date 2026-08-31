import { expect, test } from "vitest";
import {
  nodeOracleExecutable,
  oracleCacheKeyBase,
  oracleEnvironmentFingerprint,
} from "./oracle-environment.js";

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
