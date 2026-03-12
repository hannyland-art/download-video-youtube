const express = require("express");
const cors = require("cors");
const crypto = require("crypto");
const searchRouter = require("./routes/search");
const downloadRouter = require("./routes/download");

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json());

// --- Simple auth ---
const USERS = { shuli: "1" };
const tokens = new Set();

app.post("/api/login", (req, res) => {
  const { username, password } = req.body;
  if (USERS[username] && USERS[username] === password) {
    const token = crypto.randomBytes(32).toString("hex");
    tokens.add(token);
    return res.json({ token });
  }
  res.status(401).json({ error: "Invalid username or password." });
});

// Auth middleware — protect search and download routes
function authMiddleware(req, res, next) {
  const token = req.headers.authorization?.replace("Bearer ", "");
  if (token && tokens.has(token)) {
    return next();
  }
  res.status(401).json({ error: "Unauthorized. Please log in." });
}

// Routes
app.use("/api/search", authMiddleware, searchRouter);
app.use("/api/download", authMiddleware, downloadRouter);

// Health check — App Runner pings "/" by default
app.get("/", (req, res) => {
  res.json({ status: "ok" });
});

app.get("/api/health", (req, res) => {
  res.json({ status: "ok" });
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
