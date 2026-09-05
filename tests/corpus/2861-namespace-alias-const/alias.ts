import { ServerEvent } from "./event.ts";
import * as Whole from "./event.ts";

// The re-export-under-a-new-name house style: a const aliasing a module
// namespace. Qualified reads resolve through the namespace (live), and
// the alias itself is a value like the namespace is.
export const Event = ServerEvent;
export const Same = Whole;
const Local = Event;

export function describe(): string {
  return Local.define(Local.Connected);
}
