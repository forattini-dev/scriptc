import { plan } from "./plan.mjs";

const source = { width: 80, height: 40, cellSize: { width: 8, height: 16 } };
const full = plan(source);
const small = plan(source, { fit: "fill", shrink: true });
console.log(full.fit, full.visiblePixels.width, full.visiblePixels.height);
console.log(small.fit, small.visiblePixels.width, small.visiblePixels.height);
console.log("shared", full.cellSize === source.cellSize);
source.cellSize.width = 9;
full.cellSize.height = 20;
full.visiblePixels.width = 21;
console.log("mutations", full.cellSize.width, source.cellSize.height, full.visiblePixels.width, small.visiblePixels.width);
