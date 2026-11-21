// @rust-only
// @no-engine
interface Settings {
  profiles?: { defaults?: Record<string, unknown> };
}

const settings = JSON.parse("{}") as Settings;
let created = 0;
function profiles(): { defaults?: Record<string, unknown> } {
  created += 1;
  return {};
}

settings.profiles ??= profiles();
const shared = settings.profiles;
settings.profiles ??= profiles();
settings.profiles.defaults ??= {};
settings.profiles.defaults["cursorColor"] = "#ffffff";
console.log(
  created,
  shared === settings.profiles,
  settings.profiles.defaults["cursorColor"] === "#ffffff",
);
