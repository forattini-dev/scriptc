'use strict'

/** @param {Date} date */
function format(date) {
  return date.toString()
}

for (const value of [NaN, -2717640000000, -2208988800000, 0, 951782400000, 1541300400000, 1719835200000]) {
  console.log(format(new Date(value)))
}
