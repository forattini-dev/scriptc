const names = ["a b", "c/d", "x+y"];
console.log(names.map(encodeURIComponent).join("&"));
