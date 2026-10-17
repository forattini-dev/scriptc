const rows = [
  ["GET /one", { headers: { accept: "one" } }, { renamed: ["one", "first"] }],
  ["POST /two", { body: [1, 2] }, { mapToData: "body" }]
];
var alias = rows;
console.log("plain", rows === alias, alias[0][1].headers.accept === "one", alias[1][1].body[1] === 2);
