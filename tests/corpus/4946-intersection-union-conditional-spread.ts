// @rust-only
// @no-engine

type ProviderSpec =
  | { kind: "apt"; pkg: string }
  | { kind: "gh"; repo: string; asset: string; bin?: string }
  | {
      kind: "aptrepo";
      pkgs: string[];
      keyUrl: string;
      keyring: string;
      entry: string;
      group?: string;
    }
  | { kind: "skip"; reason: string };

type Provider = ProviderSpec & {
  needsSudo?: true;
  needsAdmin?: true;
};

function gh(repo: string, asset: string, bin?: string): Provider {
  return {
    kind: "gh",
    repo,
    asset,
    ...(bin ? { bin } : {}),
  };
}

function aptrepo(spec: {
  pkgs: string[];
  keyUrl: string;
  keyring: string;
  entry: string;
  group?: string;
}): Provider {
  return { kind: "aptrepo", ...spec };
}

const plain = gh("reddb/tool", "tool-*");
const named = gh("reddb/tool", "tool-*", "tool");
const repo = aptrepo({
  pkgs: ["git"],
  keyUrl: "https://example.test/key",
  keyring: "/tmp/keyring",
  entry: "deb stable main",
});
console.log(plain.kind);
console.log(Object.hasOwn(plain, "bin"));
console.log(named.kind);
console.log(named.kind === "gh" ? named.bin : "wrong");
console.log(repo.kind);
console.log(repo.kind === "aptrepo" ? repo.pkgs[0] : "wrong");
