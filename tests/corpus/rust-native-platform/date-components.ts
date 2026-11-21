const leap = new Date(2024, 1, 29);
console.log(leap.getFullYear(), leap.getMonth(), leap.getDate(), leap.getDay());

const nonLeap = new Date(2025, 1, 29);
console.log(nonLeap.getFullYear(), nonLeap.getMonth(), nonLeap.getDate());

const legacyYear = new Date(99, 0, 1);
console.log(legacyYear.getFullYear(), legacyYear.getMonth(), legacyYear.getDate());

const rolled = new Date(2024, -1, 0, 25, -1, 61, -1);
console.log(
  rolled.getFullYear(),
  rolled.getMonth(),
  rolled.getDate(),
  rolled.getHours(),
  rolled.getMinutes(),
  rolled.getSeconds(),
  rolled.getMilliseconds(),
);
