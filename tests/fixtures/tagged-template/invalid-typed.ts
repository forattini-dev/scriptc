function tag(parts: readonly string[]) {
  console.log("invalid-typed", parts[0]);
}
tag`\unicode`;
