// @ts-check
const PROFILES = {
  first: {
    id: "first",
    known: { mouse: true, hyperlinks: true },
  },
  second: {
    id: "second",
    known: { mouse: false, hyperlinks: false, graphics: true },
  },
};

/** @param {"first" | "second"} id */
function detect(id) {
  const base = PROFILES[id];
  let version;
  if (id === "first") version = "1";
  return { ...base, version };
}

/** @param {"first" | "second"} id */
function print(id) {
  const profile = detect(id);
  const known = profile.known;
  console.log("profile", profile.id, known.mouse, profile.version ?? "none");
}

print("first");
print("second");
