// @rust-only
// @no-engine
interface Profile {
  guid?: string;
  startingDirectory?: string;
  [key: string]: unknown;
}

const profiles: Profile[] = [{ guid: "profile-1", extra: 7 }];
const profile = profiles.find((entry) => entry.guid === "profile-1");
if (profile?.guid) {
  profile.startingDirectory = "/home/red";
  profile["dynamic"] = "shared";
}
console.log(
  profiles[0]?.startingDirectory === "/home/red",
  profiles[0]?.["dynamic"] === "shared",
  profiles[0]?.guid === "profile-1",
);
