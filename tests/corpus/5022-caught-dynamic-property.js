try {
  throw { status: 409, message: "conflict" };
} catch (error) {
  const caught = /** @type {any} */ (error);
  console.log(Number(caught.status));
  console.log(String(caught.message));
}
