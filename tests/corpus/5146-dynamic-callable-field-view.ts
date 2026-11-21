const source: { toJSON: unknown } = {
  toJSON() {
    return 7;
  },
};
const typed = source as { toJSON(): unknown };
console.log(String(typed.toJSON()));
