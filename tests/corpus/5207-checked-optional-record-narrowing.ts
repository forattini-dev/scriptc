interface OptionalProfile {
  name?: string;
  tools: Record<string, boolean>;
}

interface RequiredProfile {
  name: string;
  tools: Record<string, boolean>;
}

const source = {
  name: "native",
  tools: {},
} as OptionalProfile;

const profile = source as RequiredProfile | undefined;

console.log(profile!.name);
