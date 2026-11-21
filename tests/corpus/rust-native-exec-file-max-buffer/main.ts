import { execFileSync } from "node:child_process";

const helper = process.env.SCRIPTC_EXEC_FILE_HELPER!;

function run(maxBuffer: number): string {
  try {
    const output = execFileSync(helper, ["large"], { encoding: "utf8", maxBuffer });
    return `ok ${output.length}`;
  } catch (error) {
    const failure = error as NodeJS.ErrnoException;
    return `failed ${failure.code}`;
  }
}

console.log(run(16 * 1024 * 1024));
console.log(run(64));
console.log(run(16));
console.log(execFileSync(helper, ["ok"], { encoding: "utf8", maxBuffer: 1024 }).trim());
