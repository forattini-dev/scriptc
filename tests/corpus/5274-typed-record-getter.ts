interface Model {
  readonly total: number;
  label: string;
}

let count = 1;
const model: Model = {
  get total() {
    return count;
  },
  label: "ready",
};

count = 3;
console.log(model.total, model.label);
