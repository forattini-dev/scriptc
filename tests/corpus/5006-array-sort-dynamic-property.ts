const schema: any = {
  sortMapEntries: (left: number, right: number) => left - right,
};
const values = [3, 1, 2];
if (typeof schema.sortMapEntries === "function") {
  values.sort(schema.sortMapEntries);
}
console.log(values.join(","));
