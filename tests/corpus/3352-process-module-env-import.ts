import { env as settings } from "node:process";

delete process.env.SCRIPTC_PROCESS_ALIAS_PROBE;
console.log(settings.SCRIPTC_PROCESS_ALIAS_PROBE ?? "absent");
process.env.SCRIPTC_PROCESS_ALIAS_PROBE = "global";
console.log(settings.SCRIPTC_PROCESS_ALIAS_PROBE);
settings.SCRIPTC_PROCESS_ALIAS_PROBE = "alias";
console.log(process.env.SCRIPTC_PROCESS_ALIAS_PROBE);
delete settings.SCRIPTC_PROCESS_ALIAS_PROBE;
console.log(process.env.SCRIPTC_PROCESS_ALIAS_PROBE ?? "deleted");

function shadow(settings: { SCRIPTC_PROCESS_ALIAS_PROBE: string }): string {
  return settings.SCRIPTC_PROCESS_ALIAS_PROBE;
}
console.log(shadow({ SCRIPTC_PROCESS_ALIAS_PROBE: "local" }));
