function inspect(parts: TemplateStringsArray): void {
  console.log(parts.raw[0]);
}
const parts: any = ['cooked'];
parts.raw = ['raw'];
inspect(parts as TemplateStringsArray);
