import { basename } from "node:path";
import { suffix } from "./computed-helper.mjs";

export const label = `computed ${basename("/external/module")} ${suffix}`;
