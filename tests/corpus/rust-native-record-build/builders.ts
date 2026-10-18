type Provider = { kind: "aptrepo"; pkgs: string[]; keyUrl: string; keyring: string; entry: string; group?: string };
function aptrepo(spec: { pkgs: string[]; keyUrl: string; keyring: string; entry: string; group?: string }): Provider {
  return { kind: "aptrepo", ...spec };
}
const spec: { pkgs: string[]; keyUrl: string; keyring: string; entry: string; group?: string } = { pkgs: ["one"], keyUrl: "url", keyring: "ring", entry: "entry" };
const provider = aptrepo(spec);
console.log("case", provider.kind, provider.pkgs === spec.pkgs, provider.keyUrl, Object.keys(provider).join("|"));
console.log("case", Object.hasOwn(provider, "group"), aptrepo({ ...spec, group: undefined }).group === undefined);
console.log("case", Object.hasOwn(aptrepo({ ...spec, group: undefined }), "group"));
function required(yes: boolean): { a: string; b: number } { return { ...(yes ? { a: "yes" } : { a: "no" }), b: 2 }; }
console.log("case", required(true).a, required(false).a, required(false).b);
const fromLiteral = { ...{ a: "a", b: 3 }, c: true };
console.log("case", fromLiteral.a, fromLiteral.b, fromLiteral.c);
