function inspect(parts: TemplateStringsArray): void {
  console.log(typeof parts[0], parts[0], parts[1]);
}
const parts = [undefined, 'tail'] as unknown as TemplateStringsArray;
inspect(parts);
