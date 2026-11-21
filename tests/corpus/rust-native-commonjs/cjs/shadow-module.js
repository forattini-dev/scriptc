var values = [{ name: "first" }, { name: "second" }];

for (var index = 0; index < values.length; index++) {
  var module = values[index];
  exports.name = module.name;
}
