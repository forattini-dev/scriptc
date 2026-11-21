console.log("module initialized");
const pattern = /^bundle-/;
const names = ["one", "two"] as const;
export function check(): boolean { return pattern.test("bundle-app"); }
export function item(): string { return names[1]; }
