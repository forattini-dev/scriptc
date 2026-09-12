export interface LlvmTargetOptions {
  /** Pointer width of the target C ABI. Native targets are 64-bit today. */
  pointerBits?: 32 | 64;
  /** Select the WASI libc entry-point convention. */
  wasi?: boolean;
  /** Library archive assembly may move the volatile identity getters into a
   * separate translation unit. Public/direct emission keeps them by default. */
  emitLibraryIdentity?: boolean;
  /** Program objects carry a strong reference to the matching runtime ABI
   * marker so manual links against an incompatible runtime fail loudly. */
  runtimeAbiMarker?: boolean;
}
