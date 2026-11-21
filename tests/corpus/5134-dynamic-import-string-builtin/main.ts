/// <reference types="node" />
import { existsSync } from "node:fs";

interface Check {
  applies: (environment: "wsl" | "windows") => boolean | Promise<boolean>;
}

const checks: Check[] = [{
  applies: async (environment) => {
    const { localPath } = await import("./lib.ts");
    return existsSync(localPath("missing-scriptc-path", environment));
  },
}];

void Promise.resolve(checks[0].applies("windows")).then((value) => console.log(value));
