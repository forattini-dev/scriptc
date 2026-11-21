Promise.reject("failed")
  .catch((error) => {
    console.log(`caught:${error}`);
    return "recovered";
  })
  .then((value) => console.log(value));
