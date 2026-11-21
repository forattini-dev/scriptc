function tag(parts: TemplateStringsArray, value: number): string {
  return parts[0] + value + parts[1];
}
const parts = ['value=', '!'] as unknown as TemplateStringsArray;
console.log(tag(parts, 7));
