const express = require("express");
const { spawn } = require("child_process");
const path = require("path");
const fs = require("fs");
const os = require("os");
const crypto = require("crypto");
const ffmpegPath = require("ffmpeg-static");

const router = express.Router();

// Resolve the yt-dlp binary path
const ytDlpPath = path.join(__dirname, "..", "node_modules", "yt-dlp-exec", "bin", process.platform === "win32" ? "yt-dlp.exe" : "yt-dlp");

// Resolve the node binary path (yt-dlp needs a JS runtime)
const nodePath = process.execPath;

// Path to the optional cookies file
const cookiesPath = path.join(__dirname, "..", "cookies.txt");

// Optional proxy URL
const proxyUrl = process.env.PROXY_URL || "";

// Store completed downloads: fileId -> { path, title, createdAt }
const completedFiles = new Map();

// Auto-cleanup completed files older than 10 minutes
setInterval(() => {
  const now = Date.now();
  for (const [id, file] of completedFiles) {
    if (now - file.createdAt > 10 * 60 * 1000) {
      cleanupFile(file.path);
      completedFiles.delete(id);
    }
  }
}, 60 * 1000);

/**
 * Delete a file if it exists.
 */
function cleanupFile(filePath) {
  try {
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
  } catch { /* ignore */ }
}

/**
 * Build the common yt-dlp arguments.
 */
function getCommonArgs() {
  const args = [
    "--ffmpeg-location", ffmpegPath,
    "--js-runtimes", `node:${nodePath}`,
  ];
  if (fs.existsSync(cookiesPath)) args.push("--cookies", cookiesPath);
  if (proxyUrl) args.push("--proxy", proxyUrl);
  return args;
}

/**
 * Spawn yt-dlp and collect stdout as a Buffer.
 */
function spawnCollect(cmd, args, timeoutMs = 30000) {
  return new Promise((resolve) => {
    const proc = spawn(cmd, args);
    const chunks = [];
    let stderr = "";

    proc.stdout.on("data", (data) => chunks.push(data));
    proc.stderr.on("data", (data) => { stderr += data.toString(); });

    proc.on("error", (err) => {
      resolve({ code: -1, stdout: Buffer.alloc(0), stderr: err.message });
    });
    proc.on("close", (code) => {
      resolve({ code, stdout: Buffer.concat(chunks), stderr });
    });

    setTimeout(() => {
      proc.kill();
      resolve({ code: -1, stdout: Buffer.alloc(0), stderr: "Timeout" });
    }, timeoutMs);
  });
}

// ==========================================================
//  POST /file/:fileId — Serve the completed MP3 file
//  Using POST so CloudFront forwards Authorization header
//  (MUST be defined before /:videoId to avoid route conflict)
// ==========================================================
router.post("/file/:fileId", (req, res) => {
  const { fileId } = req.params;
  const entry = completedFiles.get(fileId);

  if (!entry) {
    return res.status(404).json({ error: "File not found or expired." });
  }

  if (!fs.existsSync(entry.path)) {
    completedFiles.delete(fileId);
    return res.status(404).json({ error: "File no longer available." });
  }

  const stat = fs.statSync(entry.path);
  const safeTitle = entry.title.replace(/[<>:"/\\|?*]/g, "").replace(/\s+/g, "_");
  const encodedTitle = encodeURIComponent(safeTitle);

  res.setHeader("Content-Type", "audio/mpeg");
  res.setHeader("Content-Length", stat.size);
  res.setHeader("Content-Disposition", `attachment; filename="${encodedTitle}.mp3"; filename*=UTF-8''${encodedTitle}.mp3`);

  const fileStream = fs.createReadStream(entry.path);
  fileStream.pipe(res);

  fileStream.on("end", () => {
    cleanupFile(entry.path);
    completedFiles.delete(fileId);
  });

  fileStream.on("error", (err) => {
    console.error("File stream error:", err.message);
    cleanupFile(entry.path);
    completedFiles.delete(fileId);
    if (!res.headersSent) {
      res.status(500).json({ error: "Failed to send the file." });
    }
  });
});

// ==========================================================
//  POST /:videoId — SSE progress stream
//  Using POST so CloudFront forwards Authorization header
// ==========================================================
router.post("/:videoId", async (req, res) => {
  const { videoId } = req.params;

  if (!videoId || typeof videoId !== "string") {
    return res.status(400).json({ error: "A valid videoId is required." });
  }

  // Set up SSE headers
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();

  const sendEvent = (event, data) => {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };

  const tempId = crypto.randomBytes(8).toString("hex");
  const tempFile = path.join(os.tmpdir(), `yt-mp3-${tempId}.mp3`);
  let aborted = false;
  let ytDlpProc = null;

  req.on("close", () => {
    aborted = true;
    if (ytDlpProc) {
      try { ytDlpProc.kill(); } catch { /* ignore */ }
    }
  });

  try {
    const url = `https://www.youtube.com/watch?v=${videoId}`;
    const commonArgs = getCommonArgs();

    // --- Phase 1: Get title ---
    sendEvent("progress", { phase: "info", percent: 0, message: "Getting video info..." });

    let title = videoId;
    try {
      const result = await spawnCollect(ytDlpPath, [
        ...commonArgs, "--dump-single-json", "--skip-download", url,
      ], 30000);

      if (result.code === 0 && result.stdout.length > 0) {
        const json = JSON.parse(result.stdout.toString("utf-8"));
        title = json.title || videoId;
      }
    } catch { /* use videoId as fallback title */ }

    if (aborted) { cleanupFile(tempFile); return; }

    sendEvent("progress", { phase: "info", percent: 5, message: "Starting download..." });

    // --- Phase 2: Download and convert with progress (with retry) ---
    const DL_TIMEOUT = 10 * 60 * 1000; // 10 min per attempt
    const MAX_RETRIES = 2; // up to 3 total attempts
    let actualFile = null;
    let lastError = "";

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      if (aborted) { cleanupFile(tempFile); return; }

      if (attempt > 0) {
        sendEvent("progress", { phase: "retrying", percent: 5, message: `Retry ${attempt}/${MAX_RETRIES}... restarting download` });
        cleanupFile(tempFile); // clean partial file from previous attempt
      }

      let dlExitCode = -1;
      let dlStderr = "";
      let timedOut = false;

      await new Promise((resolve) => {
        ytDlpProc = spawn(ytDlpPath, [
          ...commonArgs,
          url,
          "-x",
          "--audio-format", "mp3",
          "--audio-quality", "192K",
          "-o", tempFile,
          "--no-playlist",
          "--no-part",
          "--force-overwrites",
          "--newline",              // Output progress on new lines (easier to parse)
        ]);

        ytDlpProc.stdout.on("data", (data) => {
          const text = data.toString();
          console.log("yt-dlp stdout:", text.trim());
          const match = text.match(/\[download\]\s+([\d.]+)%/);
          if (match && !aborted) {
            const dlPercent = parseFloat(match[1]);
            const overall = Math.round(5 + (dlPercent * 0.75));
            sendEvent("progress", { phase: "downloading", percent: overall, message: `Downloading... ${Math.round(dlPercent)}%` });
          }
          if (text.includes("[ExtractAudio]") && !aborted) {
            sendEvent("progress", { phase: "converting", percent: 85, message: "Converting to MP3..." });
          }
          if (text.includes("[Merger]") && !aborted) {
            sendEvent("progress", { phase: "converting", percent: 88, message: "Merging audio..." });
          }
        });

        ytDlpProc.stderr.on("data", (data) => {
          const text = data.toString();
          dlStderr += text;
          console.error("yt-dlp stderr:", text.trim());
          const match = text.match(/\[download\]\s+([\d.]+)%/);
          if (match && !aborted) {
            const dlPercent = parseFloat(match[1]);
            const overall = Math.round(5 + (dlPercent * 0.75));
            sendEvent("progress", { phase: "downloading", percent: overall, message: `Downloading... ${Math.round(dlPercent)}%` });
          }
        });

        ytDlpProc.on("error", (err) => {
          console.error("yt-dlp process error:", err.message);
          resolve();
        });
        ytDlpProc.on("close", (code) => {
          dlExitCode = code;
          resolve();
        });

        setTimeout(() => {
          timedOut = true;
          try { ytDlpProc.kill(); } catch { /* ignore */ }
          resolve();
        }, DL_TIMEOUT);
      });

      ytDlpProc = null;

      if (aborted) { cleanupFile(tempFile); return; }

      if (timedOut) {
        lastError = "Download timed out (proxy may be too slow for this file size)";
        console.error(`Attempt ${attempt + 1}: timed out`);
        continue; // retry
      }

      // Find the output file — yt-dlp may add/change extensions
      const basePath = tempFile.replace(/\.mp3$/, "");
      const candidates = [tempFile, basePath + ".mp3", basePath, basePath + ".m4a", basePath + ".webm", basePath + ".opus"];
      for (const candidate of candidates) {
        if (fs.existsSync(candidate) && fs.statSync(candidate).size > 0) {
          actualFile = candidate;
          break;
        }
      }

      if (actualFile) break; // success!

      // Extract error for logging / retry decision
      const errorLines = dlStderr.split("\n").filter(l => l.includes("ERROR") || l.includes("error")).join(" | ");
      lastError = errorLines
        ? errorLines.substring(0, 300)
        : (dlExitCode !== 0 ? `yt-dlp exited with code ${dlExitCode}` : "No output file produced");
      console.error(`Attempt ${attempt + 1} failed:`, lastError);
    }

    // --- Phase 3: Verify output ---
    sendEvent("progress", { phase: "finalizing", percent: 92, message: "Finalizing..." });

    if (!actualFile) {
      console.error("All attempts failed. Last error:", lastError);
      sendEvent("error", { message: `Download failed after ${MAX_RETRIES + 1} attempts: ${lastError}` });
      cleanupFile(tempFile);
      res.end();
      return;
    }

    // Store the file for retrieval
    const fileId = crypto.randomBytes(12).toString("hex");
    completedFiles.set(fileId, {
      path: actualFile,
      title: title,
      createdAt: Date.now(),
    });

    sendEvent("progress", { phase: "done", percent: 100, message: "Ready!" });
    sendEvent("done", { fileId, title });
    res.end();

  } catch (error) {
    console.error("Download error:", error.message);
    cleanupFile(tempFile);
    if (!aborted) {
      sendEvent("error", { message: "Failed to process download request." });
      res.end();
    }
  }
});

module.exports = router;
