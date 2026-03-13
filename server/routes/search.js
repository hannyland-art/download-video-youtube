const express = require("express");
const { spawn } = require("child_process");
const path = require("path");
const fs = require("fs");
const https = require("https");
const http = require("http");

const router = express.Router();

// Resolve the yt-dlp binary path
const ytDlpPath = path.join(__dirname, "..", "node_modules", "yt-dlp-exec", "bin", process.platform === "win32" ? "yt-dlp.exe" : "yt-dlp");
const nodePath = process.execPath;
const cookiesPath = path.join(__dirname, "..", "cookies.txt");

// Proxy is only used for downloads, not for search/thumbnails (too slow and unnecessary)

/**
 * Spawn yt-dlp and collect stdout as a string.
 */
function ytDlpSearch(args, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    const proc = spawn(ytDlpPath, args);
    const chunks = [];
    let stderr = "";

    proc.stdout.on("data", (data) => chunks.push(data));
    proc.stderr.on("data", (data) => { stderr += data.toString(); });

    proc.on("error", (err) => reject(err));
    proc.on("close", (code) => {
      if (code === 0) {
        resolve(Buffer.concat(chunks).toString("utf-8"));
      } else {
        reject(new Error(`yt-dlp exited with code ${code}: ${stderr.substring(0, 500)}`));
      }
    });

    setTimeout(() => {
      proc.kill();
      reject(new Error("yt-dlp search timeout"));
    }, timeoutMs);
  });
}

/**
 * Format seconds into MM:SS or H:MM:SS.
 */
function formatDuration(seconds) {
  if (!seconds || isNaN(seconds)) return "N/A";
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  if (h > 0) return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  return `${m}:${String(s).padStart(2, "0")}`;
}

/**
 * Fetches an image from a URL and returns it as a base64 data URI.
 */
function fetchImageAsBase64(url) {
  return new Promise((resolve) => {
    if (!url) return resolve("");

    const client = url.startsWith("https") ? https : http;

    client
      .get(url, (response) => {
        if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
          return fetchImageAsBase64(response.headers.location).then(resolve);
        }

        if (response.statusCode !== 200) {
          return resolve("");
        }

        const contentType = response.headers["content-type"] || "image/jpeg";
        const chunks = [];

        response.on("data", (chunk) => chunks.push(chunk));
        response.on("end", () => {
          const buffer = Buffer.concat(chunks);
          resolve(`data:${contentType};base64,${buffer.toString("base64")}`);
        });
        response.on("error", () => resolve(""));
      })
      .on("error", () => resolve(""));
  });
}

router.post("/", async (req, res) => {
  try {
    const { query } = req.body;

    if (!query || typeof query !== "string" || query.trim().length === 0) {
      return res.status(400).json({ error: "A valid song name is required." });
    }

    // Build yt-dlp args for search
    const args = [
      "--js-runtimes", `node:${nodePath}`,
      `ytsearch10:${query.trim()}`,  // Search YouTube for top 10 results
      "--dump-json",                  // Output JSON for each result
      "--flat-playlist",              // Don't download, just get metadata
      "--no-warnings",
    ];

    if (fs.existsSync(cookiesPath)) {
      args.push("--cookies", cookiesPath);
    }
    // NOTE: No proxy for search — it's too slow and YouTube rarely blocks search/metadata requests

    const output = await ytDlpSearch(args, 30000);

    // yt-dlp outputs one JSON object per line
    const lines = output.trim().split("\n").filter(Boolean);
    const entries = lines.map((line) => {
      try { return JSON.parse(line); } catch { return null; }
    }).filter(Boolean);

    // Fetch all thumbnails in parallel and convert to base64
    const videos = await Promise.all(
      entries.map(async (entry) => {
        // Pick the best thumbnail URL
        const thumbnailUrl =
          entry.thumbnail ||
          (entry.thumbnails && entry.thumbnails.length > 0
            ? entry.thumbnails[entry.thumbnails.length - 1].url
            : "");

        const thumbnailBase64 = await fetchImageAsBase64(thumbnailUrl);

        return {
          videoId: entry.id,
          title: entry.title || "Unknown",
          thumbnail: thumbnailBase64,
          duration: formatDuration(entry.duration),
          channel: entry.channel || entry.uploader || "Unknown",
          url: entry.webpage_url || entry.url || `https://www.youtube.com/watch?v=${entry.id}`,
        };
      })
    );

    res.json({ results: videos });
  } catch (error) {
    console.error("Search error:", error.message);
    res.status(500).json({ error: "Failed to search YouTube. Please try again." });
  }
});

module.exports = router;
