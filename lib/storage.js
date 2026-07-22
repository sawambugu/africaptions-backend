// Storage abstraction for uploaded media/caption files.
//
// IMPORTANT (production): most PaaS hosts (Render, Railway, Heroku, Fly's
// default setup) run on an EPHEMERAL filesystem — anything written to disk
// disappears on every redeploy/restart. The "local" driver below is fine
// for local development only. In production, set STORAGE_DRIVER=s3 (or any
// S3-compatible service: AWS S3, Cloudflare R2, Backblaze B2, DigitalOcean
// Spaces) so uploaded files actually survive deploys. See
// docs/CMS_SETUP_AND_DEPLOYMENT.md for the full explanation.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DRIVER = process.env.STORAGE_DRIVER || 'local';
const LOCAL_UPLOAD_DIR = process.env.UPLOAD_DIR || path.join(__dirname, '..', 'uploads');

function uniqueFilename(originalName) {
  const ext = path.extname(originalName || '');
  return `${Date.now()}-${crypto.randomBytes(8).toString('hex')}${ext}`;
}

async function saveLocal({ buffer, originalName }) {
  fs.mkdirSync(LOCAL_UPLOAD_DIR, { recursive: true });
  const filename = uniqueFilename(originalName);
  fs.writeFileSync(path.join(LOCAL_UPLOAD_DIR, filename), buffer);
  const base = process.env.APP_URL || '';
  return `${base}/uploads/${filename}`;
}

async function saveS3({ buffer, originalName, mimeType }) {
  // Lazy-required so the dependency is only needed when STORAGE_DRIVER=s3.
  const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');

  const bucket = process.env.S3_BUCKET;
  if (!bucket) throw new Error('S3_BUCKET is not set.');

  const client = new S3Client({
    region: process.env.S3_REGION,
    endpoint: process.env.S3_ENDPOINT || undefined, // set for R2/Spaces/B2
    forcePathStyle: process.env.S3_FORCE_PATH_STYLE === 'true',
    credentials: process.env.S3_ACCESS_KEY_ID
      ? {
          accessKeyId: process.env.S3_ACCESS_KEY_ID,
          secretAccessKey: process.env.S3_SECRET_ACCESS_KEY,
        }
      : undefined,
  });

  const key = uniqueFilename(originalName);
  await client.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      Body: buffer,
      ContentType: mimeType,
    })
  );

  const publicBase = process.env.S3_PUBLIC_URL_BASE;
  return publicBase ? `${publicBase}/${key}` : `s3://${bucket}/${key}`;
}

async function saveFile(file) {
  if (DRIVER === 's3') {
    return saveS3(file);
  }
  return saveLocal(file);
}

module.exports = { saveFile, LOCAL_UPLOAD_DIR };
