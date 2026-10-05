const { versions, env } = require("node:process");
console.log(versions.node);
env.SCRIPTC_PROCESS_ALIAS_PROBE = "combined";
console.log(process.env.SCRIPTC_PROCESS_ALIAS_PROBE);
delete env.SCRIPTC_PROCESS_ALIAS_PROBE;
console.log(process.env.SCRIPTC_PROCESS_ALIAS_PROBE ?? "deleted");
