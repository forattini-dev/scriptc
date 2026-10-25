// @rust-only
// @no-engine
// @ts-nocheck
export {};
const raw = JSON.rawJSON("1");
try { delete raw.rawJSON; }
catch (error) { console.log("blocked", String(error.name), String(error.message)); }
console.log("unchanged", JSON.isRawJSON(raw) === true, JSON.stringify(raw) === "1");
console.log("absent", delete raw.absent);
