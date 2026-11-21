const value = new RegExp("a", "g");
console.log("static", value.test("a"), value.source, value.flags);
