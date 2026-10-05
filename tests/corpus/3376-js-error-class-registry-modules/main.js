// @no-engine
import { ErrorMap, NoSuchKey as MissingKey, StorageError } from "./lib.js";

const aliases = { MissingKey };
const error = new aliases.MissingKey("missing");
console.log(Object.keys(aliases).join(","));
console.log(aliases.MissingKey === ErrorMap.NoSuchKey, aliases.MissingKey.name);
console.log(error.message, error instanceof MissingKey, error instanceof StorageError, error instanceof Error);
