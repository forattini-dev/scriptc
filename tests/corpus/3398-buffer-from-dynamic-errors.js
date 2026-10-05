// @rust-only
// @no-engine

function check(value) {
  try {
    Buffer.from(value);
  } catch (error) {
    console.log(error.name, error.code, error.message);
  }
}

check(JSON.parse("null"));
check(JSON.parse("42"));
check(JSON.parse("true"));
check(JSON.parse("{}"));
check(JSON.parse("{}").missing);
