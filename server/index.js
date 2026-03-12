const express = require("express");
const cors = require("cors");
const searchRouter = require("./routes/search");
const downloadRouter = require("./routes/download");

const app = express();
const PORT = process.env.PORT || 5000;

// Middleware
app.use(cors());
app.use(express.json());

// Routes
app.use("/api/search", searchRouter);
app.use("/api/download", downloadRouter);

// Health check
app.get("/api/health", (req, res) => {
  res.json({ status: "ok" });
});

app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
