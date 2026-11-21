class Parser {
  constructor() {
    this.safeParse = this.safeParse.bind(this);
  }

  safeParse(data) {
    if (data != null) {
      return { success: true, data };
    }
    return { success: false, error: "missing" };
  }
}

const parser = new Parser();
const safeParse = parser.safeParse;
console.log(JSON.stringify(safeParse(42)), JSON.stringify(safeParse(null)));
