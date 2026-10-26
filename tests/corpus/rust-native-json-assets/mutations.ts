// @ts-nocheck
// @rust-only
// @no-engine
import data from "./asset.json" with {type: "json"};
import again from "./asset.json" with {type: "json"};
const alias: any = data;
alias.name = "changed";
console.log("changed", again.name);
delete alias.enabled;
console.log("delete", again.enabled === undefined, Object.hasOwn(again,"enabled"));
alias.nested.label = "local";
console.log("nested", again.nested.label);
console.log("json", String(JSON.stringify(data)));
alias.name = null;
console.log("retag", again.name === null);
alias.count = "many";
console.log("retag-number", again.count === "many");
