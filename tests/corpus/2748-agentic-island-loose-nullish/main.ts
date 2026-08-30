// @dynamic
// Package results are island values, and agent-written code commonly uses
// JavaScript's one useful loose comparison to test both null and undefined.
import { readProject } from "project-values";

for (const mode of ["present", "null", "missing"]) {
  const values = readProject(mode);
  if (values.project != null) console.log(`${values.project}`);
  else console.log("missing");
}
