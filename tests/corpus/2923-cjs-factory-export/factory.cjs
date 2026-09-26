let builds = 0;

function make(prefix) {
  builds++;
  return {
    prefix,
    count: builds,
  };
}

module.exports = make("root:");
module.exports.extra = "member";
