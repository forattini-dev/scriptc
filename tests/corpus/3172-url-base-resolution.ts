// @rust-only
/// <reference types="node" />
import { URL as NodeURL } from "node:url";
// Relative references, base validation, and canParse share one URL parser.
function probe(input: string, base: string): void {
  console.log("can", URL.canParse(input, base));
  try {
    const value = new URL(input, base);
    console.log(value.href, value.pathname, value.host);
  } catch (error) {
    if (error instanceof TypeError) console.log(error.name, error.message);
    else console.log("unexpected error");
  }
}

for (const input of ["../c", "./c", "/c", "//other.test/a", "?q=2", "#new", "", "../../../../x", "%2e%2e/c", "a b", "https:next", "http://else.test/x", "\\next\\path"]) {
  probe(input, "https://user:pw@example.test:8443/a/b?q=1#old");
}
probe("..", "file:///tmp/package/src/index.ts");
probe("../x y", "file:///tmp/package/src/index.ts");
probe("../x", "file:////server/a/b");
probe("../../../x", "file:////server/a/b");
probe("#f", "file:////server/a/b");
probe("file:////double/a", "https://example.test/");
probe("////double/a", "file:///tmp/x");
probe("../x", "git://host/a/b");
probe("#f", "data:text/plain,hi");
probe("child", "data:text/plain,hi");
probe("https://absolute.test/", "invalid base");
probe("/x", "http://");
probe("http://[invalid", "https://example.test/");
probe("\t../x\n", "  https://example.test/a/b  ");

function argument(label: string, value: string): string {
  console.log(label);
  return value;
}
console.log(new URL(argument("input", "../x"), argument("base", "https://example.test/a/b")).href);
console.log(URL.canParse(argument("can-input", "x"), argument("can-base", "invalid")));
const file = new URL("../x", "file:////server/a/b");
file.pathname = "//other/b";
file.searchParams.set("key", "value");
console.log(file.href);
console.log(NodeURL.canParse("../x", "https://example.test/a/b"));
console.log(new NodeURL("../x", "https://example.test/a/b").href);
