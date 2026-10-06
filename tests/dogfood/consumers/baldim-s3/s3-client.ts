import { S3Client } from "@baldim/adapter-s3";

// Offline constructor smoke test: explicit dummy credentials, no send/CRUD calls.
const client = new S3Client({
  id: "scriptc-offline-s3-probe",
  connectionString: "http://TEST_ACCESS:TEST_SECRET@127.0.0.1:9/scriptc-test/prefix?region=us-east-1",
  taskExecutor: false,
  httpClientOptions: { useReckerHandler: false, retryAttempts: 1 },
});
console.log(JSON.stringify({
  id: client.id,
  region: client.config.region,
  bucket: client.config.bucket,
  endpoint: client.config.endpoint,
  keyPrefix: client.config.keyPrefix,
  forcePathStyle: client.config.forcePathStyle,
  metadataLimit: client.metadataLimit,
  distributedMetadataLock: client.capabilities.distributedMetadataLock,
}));
await client.destroy();
