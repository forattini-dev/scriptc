var dictionary = Object.create(null);
dictionary.answer = 42;
console.log(String(dictionary.answer) + "|" + String(Object.getPrototypeOf(dictionary)));
