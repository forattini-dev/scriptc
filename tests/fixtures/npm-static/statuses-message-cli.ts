// Drive the package's internal message map through its declared public API.
// Numeric inputs still contradict status()'s JSDoc return representation.
import status from "statuses";

console.log(status("Not Found"));
console.log(status("OK"));
console.log(status("Internal Server Error"));
console.log(status("not found"));
try { status("missing status message"); }
catch (error) { console.log(error instanceof Error ? error.message : String(error)); }
