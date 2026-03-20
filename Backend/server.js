const mongoose = require("mongoose");
const app = require("./app");
const { connectToDatabase } = require("./db");
const PORT = Number(process.env.PORT) || 5000;
const HOST = process.env.HOST || "0.0.0.0";

let server;

async function startServer() {
  try {
    await connectToDatabase();
    console.log("MongoDB connected");
    server = app.listen(PORT, HOST, () => {
      console.log(`RICO Visitor System running at http://${HOST}:${PORT}`);
    });
  } catch (error) {
    console.error("Failed to connect to MongoDB:", error.message);
    process.exit(1);
  }
}

function gracefulShutdown(signal) {
  console.log(`Received ${signal}. Closing server...`);
  const closeServer = server
    ? new Promise((resolve) => server.close(resolve))
    : Promise.resolve();

  closeServer
    .then(() => mongoose.connection.close(false))
    .then(() => process.exit(0))
    .catch((error) => {
      console.error("Graceful shutdown error:", error.message);
      process.exit(1);
    });
}

process.on("SIGINT", () => gracefulShutdown("SIGINT"));
process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));

if (require.main === module) {
  startServer();
}

module.exports = app;
