class NativeDocument {
  range?: number[];

  constructor(range: number[]) {
    this.range = range;
  }
}

interface ParsedDocument extends NativeDocument {
  range: number[];
}

function* compose(): Generator<ParsedDocument, void, unknown> {
  yield new NativeDocument([0, 2, 4]) as ParsedDocument;
}

for (const document of compose()) {
  console.log(document.range.slice(0, 2).join(","));
}
