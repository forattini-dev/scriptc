export class StorageError extends Error {
  constructor(message) { super(message); }
}

export class NoSuchKey extends StorageError {}

export const ErrorMap = { NoSuchKey };
