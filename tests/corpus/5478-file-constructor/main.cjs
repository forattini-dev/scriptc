"use strict";

const file = new File(["ab"], "x.txt", {
  type: "TEXT/PLAIN",
  lastModified: 123,
});

console.log(file.name);
console.log(file.size);
console.log(file.type);
console.log(file.lastModified);
console.log(file instanceof File);
console.log(file instanceof Blob);
