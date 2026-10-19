// @rust-only
// @no-engine
import proc, { arch as architecture, platform as system } from "node:process";
import * as namespace from "node:process";
import { arch as reexportedArch, platform as reexportedPlatform } from "./properties.ts";
console.log("arch", process.arch, proc.arch, namespace.arch, architecture, reexportedArch);
console.log("platform", process.platform, proc.platform, namespace.platform, system, reexportedPlatform);
console.log("computed", process["arch"], proc["platform"], namespace["arch"]);
function select(value: string): string { return value === "arm64" ? "arm-library" : "other-library"; }
console.log("selection", select(process.arch), architecture === process.arch, system === process.platform);
function local(process: { arch: string; platform: string }): string { return process.arch + "/" + process["platform"]; }
console.log("shadow", local({ arch: "local-cpu", platform: "local-os" }));
function named(architecture: string, system: string): string { return architecture + "/" + system; }
console.log("named shadow", named("local-cpu", "local-os"));
const saved = architecture;
console.log("stored", saved, (() => reexportedArch)());
