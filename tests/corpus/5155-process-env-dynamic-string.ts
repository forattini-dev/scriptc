/// <reference types="node" />

const lease = `lease-${2 + 3}`;
process.env.SCRIPTC_DYNAMIC_ENV_WRITE = lease;
console.log(process.env.SCRIPTC_DYNAMIC_ENV_WRITE);
