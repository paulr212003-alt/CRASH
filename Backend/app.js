require("dotenv").config();
const fs = require("fs");
const path = require("path");
const express = require("express");
const cors = require("cors");
const mongoose = require("mongoose");
const visitorRoutes = require("./routes");
const { connectToDatabase } = require("./db");

const app = express();
const NODE_ENV = process.env.NODE_ENV || "development";
const CORS_ORIGINS = String(process.env.CORS_ORIGINS || "")
  .split(",")
  .map((origin) => origin.trim())
  .filter(Boolean);

function resolveFrontendPath() {
  const frontendPath = path.join(__dirname, "..", "Frontend");
  const publicPath = path.join(__dirname, "..", "public");

  if (process.env.VERCEL && fs.existsSync(publicPath)) {
    return publicPath;
  }

  if (fs.existsSync(frontendPath)) {
    return frontendPath;
  }

  if (fs.existsSync(publicPath)) {
    return publicPath;
  }

  return null;
}

function getDbStatus() {
  switch (mongoose.connection.readyState) {
    case 1:
      return "connected";
    case 2:
      return "connecting";
    case 3:
      return "disconnecting";
    default:
      return "disconnected";
  }
}

app.disable("x-powered-by");

app.use((req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "SAMEORIGIN");
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  next();
});

const corsOptions = {
  origin(origin, callback) {
    if (!origin) return callback(null, true);
    if (!CORS_ORIGINS.length) return callback(null, true);
    if (CORS_ORIGINS.includes(origin)) return callback(null, true);
    return callback(new Error("CORS not allowed for this origin."));
  },
};

app.use(cors(corsOptions));
app.use(express.json({ limit: "1mb" }));

app.get("/health", (_req, res) => {
  res.json({
    status: "ok",
    uptime: Math.floor(process.uptime()),
    env: NODE_ENV,
    db: getDbStatus(),
    timestamp: new Date().toISOString(),
  });
});

app.use("/api", async (_req, res, next) => {
  try {
    await connectToDatabase();
    next();
  } catch (error) {
    console.error("Database connection error:", error.message);
    res.status(500).json({ message: "Database connection failed.", error: error.message });
  }
});

app.use("/api", visitorRoutes);
app.use("/api", (_req, res) => {
  res.status(404).json({ message: "API route not found. Restart backend and try again." });
});

const frontendPath = resolveFrontendPath();

if (frontendPath) {
  app.use(express.static(frontendPath));

  app.get("/", (_req, res) => {
    res.sendFile(path.join(frontendPath, "index.html"));
  });
} else {
  app.get("/", (_req, res) => {
    res.status(500).send("Frontend assets not found.");
  });
}

app.use((err, _req, res, _next) => {
  console.error("Unhandled server error:", err);
  if (String(err.message || "").toLowerCase().includes("cors")) {
    return res.status(403).json({ message: "Blocked by CORS policy." });
  }
  res.status(500).json({ message: "Internal server error." });
});

module.exports = app;
