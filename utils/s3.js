const { S3Client, PutObjectCommand, GetObjectCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require("@aws-sdk/s3-request-presigner");
const fs = require('fs');
const path = require('path');

const s3Client = new S3Client({
  region: process.env.AWS_REGION,
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
  },
});

/**
 * Uploads a file to AWS S3 and returns a secure presigned URL
 * @param {string} filePath - Local path to the file
 * @param {string} fileName - Destination name in S3
 * @param {string} mimeType - File MIME type
 * @returns {Promise<string>} - S3 presigned URL
 */
const uploadToS3 = async (filePath, fileName, mimeType) => {
  const bucketName = process.env.AWS_S3_BUCKET;
  if (!bucketName) {
    throw new Error('AWS_S3_BUCKET environment variable is not set');
  }

  const fileContent = fs.readFileSync(filePath);
  const key = `recordings/${fileName}`;

  const uploadParams = {
    Bucket: bucketName,
    Key: key,
    Body: fileContent,
    ContentType: mimeType,
  };

  try {
    // 1. Upload the file
    const uploadCommand = new PutObjectCommand(uploadParams);
    await s3Client.send(uploadCommand);
    
    // 2. Generate a presigned URL for downloading (Gemini needs this)
    const getCommand = new GetObjectCommand({
      Bucket: bucketName,
      Key: key,
    });

    // URL expires in 1 hour
    const signedUrl = await getSignedUrl(s3Client, getCommand, { expiresIn: 3600 });
    return signedUrl;
  } catch (error) {
    console.error('Error uploading to S3 or generating signed URL:', error);
    throw error;
  }
};

module.exports = { s3Client, uploadToS3 };
