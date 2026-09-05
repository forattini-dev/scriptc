// The island module: a dual package whose "import" condition is an ES
// build that still calls require at top level (Bun scopes one in).
import { render, kind } from "md-lite";

const guard = new Proxy({ on: true }, {});
export function run(): string {
  return `${render("hi")} ${kind}${(guard as { on: boolean }).on ? "" : "?"}`;
}
