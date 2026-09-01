// A leading U+FEFF belongs to the STRING VALUE. It is not the source-file
// byte-order mark, so lowering must preserve it in literals and templates.
// Exactly one leading mark used to disappear after the checker, turning the
// one-character needle into an empty string and silently inverting BOM tests.
function show(label: string, value: string): void {
  const codes: number[] = [];
  for (let i = 0; i < value.length; i++) codes.push(value.charCodeAt(i));
  console.log(label, value.length, codes.join(","));
}

const plain = "hello";
console.log(
  plain.startsWith("\uFEFF"),
  plain.indexOf("\uFEFF"),
  plain.split("\uFEFF").length,
);
show("leading", "\uFEFFabc");
show("middle", "a\uFEFFb");
show("alone", "\uFEFF");
show("doubled", "\uFEFF\uFEFF");
show("template", `\uFEFFabc`);
const slot = "x";
show("template-head", `\uFEFF${slot}`);
show("template-tail", `${slot}\uFEFF`);
show("template-middle", `${slot}\uFEFF${slot}`);
