const parsed = ["1970-01-01T00:00:01.000Z", "not-a-date"].map(Date.parse);
console.log("map", parsed[0], Number.isNaN(parsed[1]));

const parseValue = Date.parse;
console.log("alias", parseValue("2000-01-01T00:00:00.000Z"));
