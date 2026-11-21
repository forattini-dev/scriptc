/// <reference types="node" />
import { readlinkSync } from "node:fs";

const path = process.env.SCRIPTC_READLINK_PATH;
console.log(path === undefined ? "ok" : readlinkSync(path).endsWith("target"));
