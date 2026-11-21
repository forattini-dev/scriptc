try {
  require("scriptc-deliberately-missing-native-addon");
  module.exports.value = "unexpected";
} catch {
  module.exports.value = "native fallback";
}

let evaluated = 0;
try {
  require(`scriptc-missing-${++evaluated}`);
} catch {
  module.exports.evaluated = evaluated;
}
