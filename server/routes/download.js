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

// Path to the optional cookies file (place cookies.txt in the server/ directory)
const cookiesPath = path.join(__dirname, "..", "cookies.txt");

/**
 * Spawn a process and wait for it to finish.
 * Returns { code, stderr }.
 */
function spawnAndWait(cmd, args, timeoutMs = 120000) {
  return new Promise((resolve) => {
    const proc = spawn(cmd, args);
    let stderr = "";

    proc.stdout.on("data", (data) => {
      console.log("yt-dlp:", data.toString());
    });
    proc.stderr.on("data", (data) => {
      stderr += data.toString();
      console.log("yt-dlp:", data.toString());
    });

    proc.on("error", (err) => {
      resolve({ code: -1, stderr: err.message, proc });
    });

    proc.on("close", (code) => {
      resolve({ code, stderr, proc });
    });

    const timer = setTimeout(() => {
      proc.kill();
      resolve({ code: -1, stderr: "Timeout: download took too long", proc });
    }, timeoutMs);

    proc.on("close", () => clearTimeout(timer));
  });
}

/**
 * Spawn a process and collect its stdout as a Buffer.
 */
function spawnCollect(cmd, args, timeoutMs = 30000) {
  return new Promise((resolve) => {
    const proc = spawn(cmd, args);
    const stdoutChunks = [];
    let stderr = "";

    proc.stdout.on("data", (data) => stdoutChunks.push(data));
    proc.stderr.on("data", (data) => { stderr += data.toString(); });

    proc.on("error", (err) => {
      resolve({ code: -1, stdout: Buffer.alloc(0), stderr: err.message });
    });

    proc.on("close", (code) => {
      resolve({ code, stdout: Buffer.concat(stdoutChunks), stderr });
    });

    setTimeout(() => {
      proc.kill();
      resolve({ code: -1, stdout: Buffer.alloc(0), stderr: "Timeout" });
    }, timeoutMs);
  });
}

/**
 * Delete a file if it exists.
 */
function cleanupFile(filePath) {
  try {
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }
  } catch {
    // ignore
  }
}

router.get("/:videoId", async (req, res) => {
  // Create a unique temp file path for this download
  const tempId = crypto.randomBytes(8).toString("hex");
  const tempFile = path.join(os.tmpdir(), `yt-mp3-${tempId}.mp3`);

  try {
    const { videoId } = req.params;

    if (!videoId || typeof videoId !== "string") {
      return res.status(400).json({ error: "A valid videoId is required." });
    }

    const url = `https://www.youtube.com/watch?v=${videoId}`;

    // Common yt-dlp args
    const ytDlpCommonArgs = [
      "--ffmpeg-location", ffmpegPath,
      "--js-runtimes", `node:${nodePath}`,
    ];

    // Add cookies if the file exists (needed for YouTube bot detection on cloud servers)
    if (fs.existsSync(cookiesPath)) {
      ytDlpCommonArgs.push("--cookies", cookiesPath);
    }

    // --- Step 1: Get the video title via JSON ---
    let title = videoId;
    try {
      const result = await spawnCollect(ytDlpPath, [
        ...ytDlpCommonArgs,
        "--dump-single-json",
        "--skip-download",
        url,
      ], 30000);

      if (result.code === 0 && result.stdout.length > 0) {
        const json = JSON.parse(result.stdout.toString("utf-8"));
        title = json.title || videoId;
      } else {
        console.error("yt-dlp title fetch failed with code:", result.code, result.stderr);
      }
    } catch (err) {
      console.error("Title fetch error:", err.message);
    }

    // --- Step 2: Download and convert to MP3 using temp file ---
    // Let yt-dlp handle everything: download + extract audio + convert to mp3
    const dlResult = await spawnAndWait(ytDlpPath, [
      ...ytDlpCommonArgs,
      url,
      "-x",                          // Extract audio
      "--audio-format", "mp3",       // Convert to mp3
      "--audio-quality", "192K",     // 192kbps bitrate
      "-o", tempFile,                // Output to temp file
      "--no-playlist",
      "--no-part",                   // Don't use .part files
      "--force-overwrites",
    ], 120000);

    // Check if client disconnected during download
    if (res.writableEnded) {
      cleanupFile(tempFile);
      return;
    }

    // yt-dlp may output to a slightly different path (adding extension)
    // Find the actual output file
    let actualFile = tempFile;
    if (!fs.existsSync(tempFile)) {
      // yt-dlp might have added .mp3 if the tempFile didn't end with it
      const altFile = tempFile.replace(/\.mp3$/, "") + ".mp3";
      if (fs.existsSync(altFile)) {
        actualFile = altFile;
      } else {
        console.error("Download failed - no output file found.");
        console.error("yt-dlp stderr:", dlResult.stderr);
        return res.status(500).json({
          error: "Failed to download or convert the audio. The video may be unavailable or restricted.",
          details: dlResult.stderr.substring(0, 500),
        });
      }
    }

    const stat = fs.statSync(actualFile);
    if (stat.size === 0) {
      cleanupFile(actualFile);
      return res.status(500).json({
        error: "Download produced an empty file.",
        details: dlResult.stderr.substring(0, 500),
      });
    }

    // --- Step 3: Send the MP3 file ---
    const safeTitle = title.replace(/[<>:"/\\|?*]/g, "").replace(/\s+/g, "_");
    const encodedTitle = encodeURIComponent(safeTitle);

    res.setHeader("Content-Type", "audio/mpeg");
    res.setHeader("Content-Length", stat.size);
    res.setHeader("Content-Disposition", `attachment; filename="${encodedTitle}.mp3"; filename*=UTF-8''${encodedTitle}.mp3`);

    const fileStream = fs.createReadStream(actualFile);
    fileStream.pipe(res);

    fileStream.on("end", () => {
      cleanupFile(actualFile);
    });

    fileStream.on("error", (err) => {
      console.error("File stream error:", err.message);
      cleanupFile(actualFile);
      if (!res.headersSent) {
        res.status(500).json({ error: "Failed to send the file." });
      }
    });

    // Cleanup if client disconnects mid-stream
    req.on("close", () => {
      if (!res.writableEnded) {
        console.log("Client disconnected, cleaning up.");
        fileStream.destroy();
        cleanupFile(actualFile);
      }
    });
  } catch (error) {
    console.error("Download error:", error.message);
    cleanupFile(tempFile);
    if (!res.headersSent) {
      res.status(500).json({ error: "Failed to process download request." });
    }
  }
});

module.exports = router;
