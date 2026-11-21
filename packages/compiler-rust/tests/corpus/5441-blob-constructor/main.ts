async function main() {
  const blob = new Blob(["hello"], { type: "TEXT/PLAIN" });
  console.log(blob instanceof Blob, blob.size, blob.type, await blob.text());
}

void main();
