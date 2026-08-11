const { createClient } = require('redis');

let isConnected = false;

const redisClient = createClient({
  url: process.env.REDIS_URL || 'redis://localhost:6379'
});

// Simple in-memory fallback for local development
const memoryCache = new Map();

redisClient.on('error', (err) => {
  if (err.code === 'ECONNREFUSED') {
    // Only log once to prevent console spam
    if (isConnected !== false) {
      console.warn('⚠️ Redis connection refused. Falling back to in-memory cache for local development.');
      isConnected = false;
    }
  } else {
    console.error('Redis Client Error', err);
  }
});

redisClient.on('ready', () => {
  isConnected = true;
  console.log('✅ Connected to Redis successfully.');
});

// Connect in the background
redisClient.connect().catch(() => {});

// Export a wrapper that dynamically chooses between Redis and Memory
module.exports = {
  get: async (key) => {
    if (isConnected) return await redisClient.get(key);
    return memoryCache.get(key) || null;
  },
  setEx: async (key, seconds, value) => {
    if (isConnected) {
      return await redisClient.setEx(key, seconds, value);
    }
    // Fallback logic
    memoryCache.set(key, value);
    setTimeout(() => memoryCache.delete(key), seconds * 1000);
    return 'OK';
  }
};
