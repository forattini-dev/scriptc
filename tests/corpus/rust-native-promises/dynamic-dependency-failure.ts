console.log("dependency attempted");
fail();
function fail(): void { throw "dependency failed"; }
export function value(): string { return "unreachable"; }
