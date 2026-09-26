const text = "─ · › αβγ 你好 🎉";

console.log("console.log", text);
console.error("console.error", text);
process.stdout.write(`stdout.write ${text}\n`);
process.stderr.write(`stderr.write ${text}\n`);
