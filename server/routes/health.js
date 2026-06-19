const express = require("express");
const fs = require("fs");
const os = require("os");
const path = require("path");
const ffmpegPath = require("ffmpeg-static");

const router = express.Router();

const ytDlpPath = path.join(
  __dirname,
  "..",
  "node_modules",
  "yt-dlp-exec",
  "bin",
  process.platform === "win32" ? "yt-dlp.exe" : "yt-dlp"
);

const cacheDir = path.join(os.homedir(), ".cache", "yt-dlp");

function checkFileExists(filePath) {
  try {
    fs.accessSync(filePath, fs.constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

function checkWritableDir(dirPath) {
  const testFile = path.join(dirPath, `.health-${process.pid}`);
  try {
    fs.mkdirSync(dirPath, { recursive: true });
    fs.writeFileSync(testFile, "ok");
    fs.unlinkSync(testFile);
    return true;
  } catch {
    return false;
  }
}

router.get("/", (_req, res) => {
  const checks = {
    ytDlp: checkFileExists(ytDlpPath),
    ffmpeg: checkFileExists(ffmpegPath),
    tmpDir: checkWritableDir(os.tmpdir()),
    cacheDir: checkWritableDir(cacheDir),
  };

  const healthy = Object.values(checks).every(Boolean);

  res.status(healthy ? 200 : 503).json({
    status: healthy ? "ok" : "degraded",
    uptime: process.uptime(),
    checks,
  });
});

module.exports = router;
