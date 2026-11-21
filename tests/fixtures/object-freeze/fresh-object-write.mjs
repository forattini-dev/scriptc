try {
  const value = Object.freeze({ x: 1 });
  value.x = 9;
  console.log("value", value.x);
} catch (error) {
  console.log(error instanceof TypeError ? "TypeError" : "other");
}
