type Policy = {
  readonly maxBytes?: number;
  readonly targetRatio: number;
};

const MIB = 1024 * 1024;
const TARGET_RATIO = 0.5;

export const RETENTION = {
  events: {
    maxBytes: 4 * MIB,
    targetRatio: TARGET_RATIO,
  },
} as const satisfies Readonly<Record<string, Policy>>;
