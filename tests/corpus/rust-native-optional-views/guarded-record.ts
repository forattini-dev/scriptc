// @rust-only
// @no-engine
interface FullIdentity {
  version: string;
  digest: string;
  sourceCommit: string;
  path: string;
}
interface PublicIdentity {
  version: string;
  digest: string;
  sourceCommit: string;
}

function consume(value: PublicIdentity | undefined): void {
  if (value) value.digest = "changed";
}
function run(active: FullIdentity | null): void {
  if (active === null) console.log("absent");
  else consume(active);
}

run(null);
const full: FullIdentity = {
  version: "1.0.0",
  digest: "before",
  sourceCommit: "abc",
  path: "/retained",
};
run(full);
console.log("identity", full.digest, full.path);

const revisions: FullIdentity[] = [full];
const selected = revisions.find((item) => item.version === "1.0.0") ?? null;
if (selected === null) console.log("missing");
else consume(selected);
console.log("const guard", full.digest, full.path);

interface RichProfile {
  name: string;
  schema: number;
  tools: { active: boolean };
  agents?: string[];
}
interface PlatformView {
  arch: string;
  profile?: RichProfile;
}
function inspectPlatform(platform: PlatformView): void {
  if (platform.profile) platform.profile.name = "nested-changed";
}
const offered = {
  arch: "x64",
  profile: { name: "minimal", schema: 1, tools: { active: true } },
};
const originalProfile = offered.profile;
inspectPlatform(offered);
console.log(
  "nested identity",
  offered.profile === originalProfile,
  offered.profile.name,
  offered.profile.tools.active,
);

