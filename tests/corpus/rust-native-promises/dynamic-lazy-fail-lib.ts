console.log("module attempted");
fail();
function fail(): void { throw "failed"; }
export function value(): string { return "unreachable"; }
