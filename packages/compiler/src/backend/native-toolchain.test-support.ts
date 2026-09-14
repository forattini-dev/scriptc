/** Cache fixtures own these process observations. A desktop loader override
 * correctly disables production caches, while a stable-toolchain hint skips
 * the fresh probes these tests need. Restore both when the suite finishes. */
export function isolateNativeToolchainEnvironment(): () => void {
  const keys = ["LD_LIBRARY_PATH", "SCRIPTC_TEST_STABLE_TOOLCHAIN"] as const;
  const original = keys.map(key => process.env[key]);
  for (const key of keys) delete process.env[key];
  return () => {
    for (const [index, key] of keys.entries()) {
      const value = original[index];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  };
}
