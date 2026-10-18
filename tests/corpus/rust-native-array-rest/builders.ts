type Provider = { kind: "gh"; repo: string; asset: string; silentArgs: string[] } | { kind: "installer"; url: string; args: string[] };
const ghInstaller = (repo: string, asset: string, ...silentArgs: string[]): Provider => ({ kind: "gh", repo, asset, silentArgs });
const installer = (url: string, ...args: string[]): Provider => ({ kind: "installer", url, args });
console.log("builders", ghInstaller("repo", "asset").kind, ghInstaller("repo", "asset", "/S", "/quiet").kind, installer("url", "-q").kind);
function array(...values: number[]): number[] { return values; }
console.log(array().length, array(1, 2, 3).join("|"));
const make = (prefix: string, ...values: string[]) => prefix + ":" + values.join("|");
console.log("rest", make("empty"), make("many", "a", "b", "c"));
