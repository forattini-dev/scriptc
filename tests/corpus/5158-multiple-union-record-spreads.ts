interface Preferences {
  theme?: string;
  apps?: string[];
}

function childPreferences(): Preferences {
  return { theme: "dark" };
}

function merge(stored: Record<string, unknown> | Preferences) {
  return { ...stored, ...childPreferences() };
}

const indexed: Record<string, unknown> = { extra: 1 };
const preferences: Preferences = { apps: ["one"] };
function encode(value: unknown): string {
  const encoded = JSON.stringify(value);
  return encoded === undefined ? "" : encoded;
}
console.log(encode(merge(indexed)));
console.log(encode(merge(preferences)));
