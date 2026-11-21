import * as source from "./spread-lib.ts";

const snapshot = {
  ...source,
  label: "override",
};

console.log("namespace spread", snapshot.label, snapshot.kind(2n));
