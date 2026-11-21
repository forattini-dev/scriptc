import { useState } from "./state.js";

const [lines, setLines] = useState<string[]>([]);
const max = 2;
const push = (line: string): void =>
  setLines((prev) => (prev.length < max ? [...prev, line] : [...prev.slice(1), line]));

push("a");
push("b");
console.log(lines().includes("a"), lines().length);
