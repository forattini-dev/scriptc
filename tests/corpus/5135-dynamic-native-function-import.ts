/// <reference types="node" />

interface Check {
  applies: () => boolean | Promise<boolean>;
}

const checks: Check[] = [{
  applies: async () => {
    const { existsSync } = await import("node:fs");
    return existsSync("scriptc-path-that-does-not-exist");
  },
}];

void Promise.resolve(checks[0].applies()).then((value) => console.log(value));
