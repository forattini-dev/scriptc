// @ts-nocheck
// @rust-only
// @no-engine
const raw = JSON.rawJSON;
const check = JSON.isRawJSON;
console.log("raw JSON sources", raw.toString(), check.toString(), raw === JSON.rawJSON, check === JSON.isRawJSON);
