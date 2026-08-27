'use strict';
const { Readable, finished } = require('stream');

function complete(error) {
  console.log(error ? `${error.code}|${error.message}` : 'clean');
}

const cancelled = new Readable({ read() {} });
const cleanup = finished(cancelled, complete);
cleanup();
cancelled.destroy();

const failed = new Readable({ read() {} });
finished(failed, complete);
failed.destroy(new Error('boom'));
