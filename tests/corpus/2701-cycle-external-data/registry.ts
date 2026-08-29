const KIB = 1024;

export const REGISTRY = {
  lane: {
    maxBytes: 4 * KIB,
    targetRatio: 0.5,
  },
} as const;
