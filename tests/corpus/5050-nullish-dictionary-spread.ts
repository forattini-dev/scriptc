type Dictionary = Readonly<Record<string, string | undefined>>;

function copy(input?: Dictionary): Record<string, string | undefined> {
  return {
    ...(input ?? {}),
    ...(input ? { tail: "present" } : {}),
  };
}

const present = copy({ first: "one", explicit: undefined });
console.log(present.first);
console.log(Object.keys(present).join(","));
console.log(copy(undefined).first ?? "empty");
