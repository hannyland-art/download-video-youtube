const express = require("express");
const { spawn } = require("child_process");
const path = require("path");
const ffmpegPath = require("ffmpeg-static");

const router = express.Router();

// Resolve the yt-dlp binary path
const ytDlpPath = path.join(__dirname, "..", "node_modules", "yt-dlp-exec", "bin", process.platform === "win32" ? "yt-dlp.exe" : "yt-dlp");

// Resolve the node binary path (yt-dlp needs a JS runtime)
const nodePath = process.execPath;

/**
 * Helper to kill a spawned process safely.
 */
function killSafe(proc) {
  try {
    if (proc && !proc.killed) {
      proc.kill();
    }
  } catch {
    // ignore — process may already be dead
  }
}

/**
 * Spawn a process and collect its stdout as a Buffer.
 * Returns { code, stdout, stderr }.
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

router.get("/:videoId", async (req, res) => {
  let ytDlpProc = null;
  let ffmpegProc = null;

  const cleanup = () => {
    killSafe(ytDlpProc);
    killSafe(ffmpegProc);
  };

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

    // --- Step 1: Get the video title via JSON ---
    let title = videoId;
    try {
      const result = await spawnCollect(ytDlpPath, [
        ...ytDlpCommonArgs,
        "--dump-single-json",
        "--skip-download",
        url,
      ], 20000);

      if (result.stderr) console.log("yt-dlp title stderr:", result.stderr);

      if (result.code === 0 && result.stdout.length > 0) {
        const json = JSON.parse(result.stdout.toString("utf-8"));
        title = json.title || videoId;
      } else {
        console.error("yt-dlp title fetch failed with code:", result.code);
      }
    } catch (err) {
      console.error("Title fetch error:", err.message);
    }

    // --- Step 2: Download audio and convert to MP3 ---
    // We collect everything into a buffer first so we can return a proper error if it fails
    const mp3Result = await new Promise((resolve) => {
      const mp3Chunks = [];
      let ytDlpStderr = "";
      let ffmpegStderr = "";
      let hasError = false;

      ytDlpProc = spawn(ytDlpPath, [
        ...ytDlpCommonArgs,
        url,
        "-f", "bestaudio",
        "-o", "-",
        "--no-playlist",
      ]);

      ffmpegProc = spawn(ffmpegPath, [
        "-i", "pipe:0",
        "-vn",
        "-ab", "192k",
        "-ar", "44100",
        "-f", "mp3",
        "pipe:1",
      ]);

      // Error handlers on all streams to prevent EPIPE crashes
      ytDlpProc.stdout.on("error", () => {});
      ytDlpProc.stdin?.on("error", () => {});
      ffmpegProc.stdout.on("error", () => {});
      ffmpegProc.stdin.on("error", () => {});

      // Pipe yt-dlp → ffmpeg
      ytDlpProc.stdout.pipe(ffmpegProc.stdin);

      // Collect ffmpeg output
      ffmpegProc.stdout.on("data", (data) => mp3Chunks.push(data));

      ytDlpProc.stderr.on("data", (data) => {
        ytDlpStderr += data.toString();
      });
      ffmpegProc.stderr.on("data", (data) => {
        ffmpegStderr += data.toString();
      });

      ytDlpProc.on("error", (err) => {
        hasError = true;
        console.error("yt-dlp spawn error:", err.message);
      });

      ffmpegProc.on("error", (err) => {
        hasError = true;
        console.error("ffmpeg spawn error:", err.message);
      });

      ytDlpProc.on("close", (code) => {
        if (code !== 0) {
          console.error(`yt-dlp exited with code ${code}`);
          console.error("yt-dlp stderr:", ytDlpStderr);
          try { ffmpegProc.stdin.end(); } catch { /* ignore */ }
        }
      });

      ffmpegProc.on("close", (code) => {
        if (code !== 0 && code !== null) {
          console.error(`ffmpeg exited with code ${code}`);
          console.error("ffmpeg stderr:", ffmpegStderr);
        }
        const buffer = Buffer.concat(mp3Chunks);
        resolve({
          success: !hasError && buffer.length > 0,
          buffer,
          ytDlpStderr,
          ffmpegStderr,
        });
      });

      // If the client disconnects, abort
      req.on("close", () => {
        if (!res.writableEnded) {
          console.log("Client disconnected, cleaning up download processes.");
          cleanup();
          resolve({ success: false, buffer: Buffer.alloc(0), ytDlpStderr: "", ffmpegStderr: "Client disconnected" });
        }
      });
    });

    // --- Step 3: Send the response ---
    if (!mp3Result.success || mp3Result.buffer.length === 0) {
      if (!res.headersSent) {
        console.error("Download produced no data. yt-dlp stderr:", mp3Result.ytDlpStderr);
        return res.status(500).json({
          error: "Failed to download or convert the audio. The video may be unavailable or restricted.",
          details: mp3Result.ytDlpStderr.substring(0, 500),
        });
      }
      return;
    }

    // Sanitize filename — only remove characters that are invalid in filenames
    const safeTitle = title.replace(/[<>:"/\\|?*]/g, "").replace(/\s+/g, "_");
    const encodedTitle = encodeURIComponent(safeTitle);

    res.setHeader("Content-Type", "audio/mpeg");
    res.setHeader("Content-Length", mp3Result.buffer.length);
    res.setHeader("Content-Disposition", `attachment; filename="${encodedTitle}.mp3"; filename*=UTF-8''${encodedTitle}.mp3`);
    res.send(mp3Result.buffer);
  } catch (error) {
    console.error("Download error:", error.message);
    cleanup();
    if (!res.headersSent) {
      res.status(500).json({ error: "Failed to process download request." });
    }
  }
});

module.exports = router;
