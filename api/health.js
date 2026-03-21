const mongoose = require("mongoose");
const { connectToDatabase } = require("../Backend/db");

module.exports = async function healthHandler(_req, res) {
  try {
    await connectToDatabase();

    return res.status(200).json({
      status: "ok",
      env: process.env.NODE_ENV || "production",
      db: mongoose.connection.readyState === 1 ? "connected" : "connecting",
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    return res.status(500).json({
      status: "error",
      db: "disconnected",
      message: "Database connection failed.",
      error: error.message,
      timestamp: new Date().toISOString(),
    });
  }
};
