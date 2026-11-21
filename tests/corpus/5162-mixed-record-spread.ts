interface Config {
  [key: string]: unknown;
  preferences: Record<string, unknown>;
  profile?: Record<string, unknown>;
}

const current = { preferences: { old: true }, extra: "kept" };
const next: Config = {
  ...current,
  preferences: { ...current.preferences, fresh: 2 },
  profile: { name: "native" },
};

const encoded = JSON.stringify(next);
console.log(encoded === undefined ? "" : encoded);
