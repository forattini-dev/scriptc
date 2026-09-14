function codes(value: string): string {
  const out: number[] = [];
  for (let i = 0; i < value.length; i++) out.push(value.charCodeAt(i));
  return out.join(",");
}

function show(label: string, value: string): void {
  console.log(`${label} len=${value.length} codes=[${codes(value)}]`);
}

const marker = "\uFEFF";
show("alone", marker);
show("leading", "\uFEFFabc");
show("middle", "a\uFEFFb");
show("doubled", "\uFEFF\uFEFF");
show("template", `\uFEFFabc`);
show("template-head", `\uFEFF${"x"}`);
show("template-tail", `${"x"}\uFEFF`);

function cooked(parts: TemplateStringsArray): string {
  return parts[0] ?? "";
}
show("tagged", cooked`\uFEFFtag`);

const keyed = { "\uFEFFkey": 7 };
const key = Object.keys(keyed)[0] ?? "";
console.log(`key len=${key.length} first=${key.charCodeAt(0)} value=${keyed["\uFEFFkey"]}`);

const plain = "hello";
console.log(`detect starts=${plain.startsWith(marker)} index=${plain.indexOf(marker)} parts=${plain.split(marker).length}`);
