const tag = {
  test: /^(?:null)?$/,
  check: (value) => tag.test.test(value),
};

exports.tag = tag;
