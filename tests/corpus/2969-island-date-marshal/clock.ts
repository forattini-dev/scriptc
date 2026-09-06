// The island module (Proxy keeps it there): a Date handed in from
// static code arrives as a real engine Date.
const guard = new Proxy({ on: true }, {});
export function describe(d: any): string {
  return `${d instanceof Date} ${d.toISOString()} ${d.getUTCFullYear()} ${typeof d.getTime()}${(guard as { on: boolean }).on ? "" : "?"}`;
}
