export * as ServerEvent from "./event.ts";

export const Connected = "server.connected";
export const Disposed = "global.disposed";
export function define(type: string): string {
  return `event:${type}`;
}
