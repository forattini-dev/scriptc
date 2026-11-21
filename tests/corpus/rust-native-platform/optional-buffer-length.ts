function measure(result: { rawOutput?: Buffer; stdout: string; stderr: string }): number {
  return (result.rawOutput?.length ?? result.stdout.length) + result.stderr.length;
}

console.log(measure({ rawOutput: Buffer.from("hello"), stdout: "hi", stderr: "!" }));
console.log(measure({ stdout: "hi", stderr: "!" }));
