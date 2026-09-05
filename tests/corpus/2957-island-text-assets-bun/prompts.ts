// The island module: Bun's loaders serve a bare .txt import as the file
// content and `with { type: "text" }` the same for any extension.
import PROMPT from "./initialize.txt";
import NOTES from "./notes.md" with { type: "text" };

export function prompt(): string {
  return PROMPT;
}
export function notes(): string {
  return NOTES;
}
