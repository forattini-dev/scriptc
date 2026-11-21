function tag(parts: readonly string[], value: number): string {
  return parts[0] + value + parts[1];
}
console.log(tag`value=${7}!`);
