// C-lane executable budgets, shared by the island and regex linkage gates.
// Linux/clang 18.1.3: static 468,192 bytes; regex 629,072; engine 1,795,224.
// The Linux ceilings leave about two ELF pages, far below optional linkage.
// Rebuilding runtime 297c6812 reproduces the former 387,600-byte baseline
// within 8 bytes; HEAD already measures 463,728 before the current WIP.
// See tests/dogfood/native-size-gate.md for recipes and attribution.
// Darwin ceilings retain their existing values; no Darwin remeasurement
// was performed in the Linux audit.
export const C_STATIC_SIZE_LIMIT = process.platform === "linux" ? 476_000 : 415_000;
export const C_REGEX_SIZE_LIMIT = process.platform === "linux" ? 637_000 : 545_000;
