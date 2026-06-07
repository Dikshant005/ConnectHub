const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');
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
 * Uploads a file to AWS S3 and returns its public URL
 * @param {string} filePath - Local path to the file
 * @param {string} fileName - Destination name in S3
 * @param {string} mimeType - File MIME type
 * @returns {Promise<string>} - S3 public URL
 */
const uploadToS3 = async (filePath, fileName, mimeType) => {
  const bucketName = process.env.AWS_S3_BUCKET;
  if (!bucketName) {
    throw new Error('AWS_S3_BUCKET environment variable is not set');
  }

  const fileContent = fs.readFileSync(filePath);

  const params = {
    Bucket: bucketName,
    Key: `recordings/${fileName}`,
    Body: fileContent,
    ContentType: mimeType,
  };

  try {
    const command = new PutObjectCommand(params);
    await s3Client.send(command);
    
    // Construct the public URL (Note: This assumes the bucket/object has public read access 
    // or you are using a cloudfront/pre-signed URL strategy. 
    // Standard public URL: https://BUCKET.s3.REGION.amazonaws.com/KEY)
    return `https://${bucketName}.s3.${process.env.AWS_REGION}.amazonaws.com/recordings/${fileName}`;
  } catch (error) {
    console.error('Error uploading to S3:', error);
    throw error;
  }
};

module.exports = { s3Client, uploadToS3 };
