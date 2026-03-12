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

router.get("/:videoId", async (req, res) => {
  let ytDlpProc = null;
  let ffmpegProc = null;

  // Cleanup function — kill both processes
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

    // Common yt-dlp args: tell it where ffmpeg and the JS runtime are
    const ytDlpCommonArgs = [
      "--ffmpeg-location", ffmpegPath,
      "--js-runtimes", `node:${nodePath}`,
    ];

    // Get the video title via JSON (--get-title has encoding issues on Windows)
    let title = videoId;
    try {
      title = await new Promise((resolve, reject) => {
        const chunks = [];
        const proc = spawn(ytDlpPath, [
          ...ytDlpCommonArgs,
          "--dump-single-json",
          "--skip-download",
          url
        ]);
        proc.stdout.on("data", (data) => { chunks.push(data); });
        proc.stderr.on("data", (data) => { console.log("yt-dlp title stderr:", data.toString()); });
        proc.on("close", (code) => {
          if (code === 0) {
            try {
              const json = JSON.parse(Buffer.concat(chunks).toString("utf-8"));
              resolve(json.title || videoId);
            } catch {
              reject(new Error("Failed to parse JSON"));
            }
          } else {
            reject(new Error(`yt-dlp exited with code ${code}`));
          }
        });
        proc.on("error", reject);
        // Timeout after 20 seconds
        setTimeout(() => { proc.kill(); reject(new Error("Timeout")); }, 20000);
      });
    } catch {
      // If we can't get the title, use videoId as fallback
    }

    // Sanitize filename — only remove characters that are invalid in filenames
    const safeTitle = title.replace(/[<>:"/\\|?*]/g, "").replace(/\s+/g, "_");

    res.setHeader("Content-Type", "audio/mpeg");
    // Use RFC 5987 encoding (filename*=UTF-8'') so browsers handle Hebrew/Unicode filenames correctly
    const encodedTitle = encodeURIComponent(safeTitle);
    res.setHeader("Content-Disposition", `attachment; filename="${encodedTitle}.mp3"; filename*=UTF-8''${encodedTitle}.mp3`);

    // Use yt-dlp to extract audio and pipe through ffmpeg to convert to mp3
    ytDlpProc = spawn(ytDlpPath, [
      ...ytDlpCommonArgs,
      url,
      "-f", "bestaudio",
      "-o", "-",           // Output to stdout
      "--no-playlist",
    ]);

    ffmpegProc = spawn(ffmpegPath, [
      "-i", "pipe:0",     // Read from stdin
      "-vn",              // No video
      "-ab", "192k",      // Audio bitrate
      "-ar", "44100",     // Audio sample rate
      "-f", "mp3",        // Output format
      "pipe:1",           // Output to stdout
    ]);

    // Attach error handlers on ALL streams to prevent unhandled EPIPE crashes
    ytDlpProc.stdout.on("error", (err) => {
      console.log("yt-dlp stdout error (ignored):", err.code);
    });
    ytDlpProc.stdin?.on("error", (err) => {
      console.log("yt-dlp stdin error (ignored):", err.code);
    });
    ffmpegProc.stdout.on("error", (err) => {
      console.log("ffmpeg stdout error (ignored):", err.code);
    });
    ffmpegProc.stdin.on("error", (err) => {
      console.log("ffmpeg stdin error (ignored):", err.code);
    });

    // Pipe yt-dlp output into ffmpeg
    ytDlpProc.stdout.pipe(ffmpegProc.stdin);

    // Pipe ffmpeg output to the HTTP response
    ffmpegProc.stdout.pipe(res);

    // Handle process-level errors
    ytDlpProc.stderr.on("data", (data) => {
      console.log("yt-dlp:", data.toString());
    });

    ffmpegProc.stderr.on("data", () => {
      // ffmpeg writes progress to stderr, which is normal
    });

    ytDlpProc.on("error", (err) => {
      console.error("yt-dlp spawn error:", err.message);
      cleanup();
      if (!res.headersSent) {
        res.status(500).json({ error: "Failed to download audio." });
      }
    });

    ffmpegProc.on("error", (err) => {
      console.error("ffmpeg spawn error:", err.message);
      cleanup();
      if (!res.headersSent) {
        res.status(500).json({ error: "Failed to convert audio. Make sure FFmpeg is installed." });
      }
    });

    ytDlpProc.on("close", (code) => {
      if (code !== 0) {
        console.error(`yt-dlp exited with code ${code}`);
        try { ffmpegProc.stdin.end(); } catch { /* ignore */ }
      }
    });

    ffmpegProc.on("close", (code) => {
      if (code !== 0 && code !== null) {
        console.error(`ffmpeg exited with code ${code}`);
      }
    });

    // If the client disconnects (cancel download), clean up gracefully
    req.on("close", () => {
      console.log("Client disconnected, cleaning up download processes.");
      cleanup();
    });

    // Catch errors on the response stream itself (e.g. client abort)
    res.on("error", (err) => {
      console.log("Response stream error (ignored):", err.code);
      cleanup();
    });
  } catch (error) {
    console.error("Download error:", error.message);
    cleanup();
    if (!res.headersSent) {
      res.status(500).json({ error: "Failed to process download request." });
    }
  }
});

module.exports = router;
