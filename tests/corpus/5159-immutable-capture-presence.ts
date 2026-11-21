interface Profile {
  name: string;
  apps?: string[];
}

function readProfile(): Profile | null {
  return { name: "native", apps: ["one"] };
}

function selected(): [string, string[]][] {
  const profile = readProfile();
  if (!profile) return [];
  return ["apps"].flatMap(key => {
    const value = profile[key as "apps"];
    return value === undefined ? [] : [[key, value]];
  });
}

function encode(value: unknown): string {
  const encoded = JSON.stringify(value);
  return encoded === undefined ? "" : encoded;
}

console.log(encode(selected()));
