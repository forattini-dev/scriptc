import { expect, test } from "vitest";
import {
  sandboxRunnerConfig,
  sandboxTestWorkerAllocation,
} from "../../scripts/sandbox-config.mjs";

test("runner settings are read after loading the sandbox environment", () => {
  expect(
    sandboxRunnerConfig({
      SCRIPTC_SANDBOX_VCPUS: "16",
      SCRIPTC_TEST_WORKERS: "7",
      SCRIPTC_LOCAL_TEST_WORKERS: "3",
      SCRIPTC_LOCAL_CASE_SHARDS: "4",
      SCRIPTC_SANDBOX_TIMEOUT: "90m",
    }),
  ).toEqual({
    vcpus: "16",
    testWorkers: "7",
    localTestWorkers: "3",
    localCaseShards: "4",
    sandboxTimeout: "90m",
  });
});

test("runner settings retain their documented defaults", () => {
  expect(sandboxRunnerConfig({})).toEqual({
    vcpus: "8",
    testWorkers: "2",
    localTestWorkers: "2",
    localCaseShards: "2",
    sandboxTimeout: "45m",
  });
});

test("test processes stay within the per-Sandbox worker budget", () => {
  expect(sandboxTestWorkerAllocation(4, 1)).toEqual({
    caseWorkers: 3,
    sideConcurrency: 1,
  });
  expect(sandboxTestWorkerAllocation(4, 2)).toEqual({
    caseWorkers: 2,
    sideConcurrency: 2,
  });
  expect(sandboxTestWorkerAllocation(2, 2)).toEqual({
    caseWorkers: 1,
    sideConcurrency: 1,
  });
  expect(sandboxTestWorkerAllocation(1, 2)).toEqual({
    caseWorkers: 1,
    sideConcurrency: 0,
  });
});
