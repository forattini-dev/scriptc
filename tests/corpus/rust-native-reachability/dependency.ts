console.log("dependency initialization");
const value = announce();
function announce(): number { console.log("unused binding initializer", 7); return 7; }
export function twice(n: number): number { return n * 2; }
export async function unusedExport(): Promise<number> { return 99; }
