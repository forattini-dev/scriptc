function text(value: Uint8Array | undefined): string {
  return value?.toString() ?? "missing";
}

function bufferText(value: Buffer | undefined): string {
  return value?.toString() ?? "missing";
}

console.log("optional bytes", text(new Uint8Array([65, 66])), text(undefined));
console.log("optional buffer", bufferText(Buffer.from("AB")), bufferText(undefined));
