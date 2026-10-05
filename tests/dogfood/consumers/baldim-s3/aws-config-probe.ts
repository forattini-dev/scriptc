import { S3Client } from "@aws-sdk/client-s3";
const client = new S3Client({
  region: "us-east-1",
  endpoint: "http://127.0.0.1:9",
  credentials: { accessKeyId: "TEST_ACCESS", secretAccessKey: "TEST_SECRET" },
});
console.log("constructed");
client.destroy();
