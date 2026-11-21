async function main() {
  const seen: string[] = [];
  const stream = new WritableStream<string>({
    write(chunk) { seen.push(chunk); },
    close() { seen.push("closed"); },
    abort(reason) { seen.push(`abort:${reason}`); }
  });
  const writer = stream.getWriter();
  await writer.write("hello");
  await writer.close();
  console.log(seen.join(","));
}
void main();
