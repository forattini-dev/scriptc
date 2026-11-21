type Provider =
  | { kind: "apt"; pkg: string }
  | { kind: "skip"; reason: string };

function describe(provider: Provider): string {
  switch (provider.kind) {
    case "apt":
      return `apt:${provider.pkg}`;
    case "skip":
      return `skip:${provider.reason}`;
  }
}

console.log(describe({ kind: "apt", pkg: "native" }));
console.log(describe({ kind: "skip", reason: "rust" }));
