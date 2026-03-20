const mongoose = require("mongoose");

const MONGO_URI = process.env.MONGO_URI || "mongodb://127.0.0.1:27017/visitorDB";

const globalCache = global.__ricoMongoCache || {
  conn: null,
  promise: null,
};

global.__ricoMongoCache = globalCache;

async function connectToDatabase() {
  if (globalCache.conn && mongoose.connection.readyState === 1) {
    return globalCache.conn;
  }

  if (!globalCache.promise) {
    globalCache.promise = mongoose.connect(MONGO_URI, {
      serverSelectionTimeoutMS: 10000,
    });
  }

  try {
    globalCache.conn = await globalCache.promise;
    return globalCache.conn;
  } catch (error) {
    globalCache.promise = null;
    throw error;
  }
}

module.exports = {
  connectToDatabase,
  MONGO_URI,
};
