type Policy = {
  readonly maxBytes?: number;
  readonly targetRatio: number;
};

const MIB = 1024 * 1024;

export const RETENTION = {
  events: {
    maxBytes: 4 * MIB,
    targetRatio: 0.5,
  },
} as const satisfies Readonly<Record<string, Policy>>;
