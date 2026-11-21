class DocumentRange {
  range?: number[];
}

const document = new DocumentRange();
document.range = [0, 2, 4];
if (document.range) {
  document.range[2] = 8;
}
console.log(document.range.join(","));
