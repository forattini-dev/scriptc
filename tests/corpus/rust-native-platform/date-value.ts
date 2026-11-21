console.log(Date.UTC(1970, 0, 1) === 0);
console.log(Date.UTC(2017, 13, 1) === Date.UTC(2018, 1, 1));
console.log(Date.UTC(2017, 0, 60) === Date.UTC(2017, 2, 1));
console.log(
  Date.UTC(96, 1, 2, 3, 4, 5, 6) ===
    Date.UTC(1996, 1, 2, 3, 4, 5, 6),
);
