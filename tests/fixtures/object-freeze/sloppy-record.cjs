const value = Object.freeze({ x: 1 });
try {
  value.x = 9;
  value.extra = 7;
  console.log(value.x, value.extra);
} catch (error) {
  console.log(error instanceof TypeError ? "TypeError" : "other");
}
