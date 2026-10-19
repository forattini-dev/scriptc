import { memo } from "./cycle-a.ts";
try { console.log("cycle early", memo === undefined); } catch (error) { console.log("cycle TDZ", (error as Error).message); }
export function read(): void { if (memo !== undefined) console.log("cycle live", memo); }
