class DocumentValue {
  range = [0, 2];
}

function* documents(): Generator<DocumentValue, void, unknown> {
  yield new DocumentValue();
  yield new DocumentValue();
}

let document: DocumentValue | null = null;
for (const current of documents()) {
  if (!document) document = current;
  else console.log(current.range.slice(0, 2).join(","));
}
