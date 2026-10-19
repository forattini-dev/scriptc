type Spec = { kind: "apt"; pkg: string } | { kind: "builtin"; name: "ssh-server" | "one" } | { kind: "skip"; reason: string };
type Provider = Spec & { needsSudo?: true; needsAdmin?: true };
const builtin = (name: "ssh-server" | "one"): Provider => ({ kind: "builtin", name });
const sudoProvider = (pr: Spec): Provider => ({ ...pr, needsSudo: true });
const admin = (pr: Spec): Provider => ({ ...pr, needsAdmin: true });
function show(pr: Provider): void { console.log("case", pr.kind, pr.needsSudo === true, pr.needsAdmin === true, Object.keys(pr).join("|")); }
show(sudoProvider(builtin("ssh-server"))); show(admin(builtin("one"))); show(sudoProvider(admin(builtin("ssh-server"))));
show(admin(sudoProvider({kind: "apt", pkg: "git"}))); show(sudoProvider({ kind: "skip", reason: "done" }));
