/** libuv exposes the destination platform's open flags, never the compiler
 * host's values. Keep named and namespace imports on the same table. */
export function fsConstantValue(name: string, platform: string): number | undefined {
  const common: Readonly<Record<string, number>> = {
    F_OK: 0, X_OK: 1, W_OK: 2, R_OK: 4,
    O_RDONLY: 0, O_WRONLY: 1, O_RDWR: 2,
  };
  if (Object.hasOwn(common, name)) return common[name];
  const flags: Readonly<Record<string, readonly number[]>> = {
    linux: [64, 128, 512, 1024],
    android: [64, 128, 512, 1024],
    darwin: [512, 2048, 1024, 8],
    freebsd: [512, 2048, 1024, 8],
    win32: [256, 1024, 512, 8],
  };
  const index = ["O_CREAT", "O_EXCL", "O_TRUNC", "O_APPEND"].indexOf(name);
  return index < 0 || !Object.hasOwn(flags, platform) ? undefined : flags[platform]?.[index];
}
