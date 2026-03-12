const express = require("express");
const { execFile } = require("child_process");
const { spawn } = require("child_process");
const path = require("path");

const router = express.Router();

router.get("/", async (req, res) => {
  try {
    const { videoId } = req.query;

    if (!videoId || typeof videoId !== "string") {
      return res.status(400).json({ error: "A valid videoId is required." });
    }

    const url = `https://www.youtube.com/watch?v=${videoId}`;

    // First, get the video title for the filename
    let title = videoId;
    try {
      const ytDlpPath = require("yt-dlp-exec").path;
      title = await new Promise((resolve, reject) => {
        execFile(ytDlpPath, ["--get-title", url], { timeout: 15000 }, (err, stdout) => {
          if (err) return reject(err);
          resolve(stdout.trim());
        });
      });
    } catch {
      // If we can't get the title, use videoId as fallback
    }

    // Sanitize filename
    const safeTitle = title.replace(/[^\w\s-]/g, "").replace(/\s+/g, "_");

    res.setHeader("Content-Type", "audio/mpeg");
    res.setHeader("Content-Disposition", `attachment; filename="${safeTitle}.mp3"`);

    const ytDlpPath = require("yt-dlp-exec").path;

    // Use yt-dlp to extract audio and pipe through ffmpeg to convert to mp3
    const ytDlp = spawn(ytDlpPath, [
      url,
      "-f", "bestaudio",
      "-o", "-",           // Output to stdout
      "--no-playlist",
    ]);

    const ffmpeg = spawn("ffmpeg", [
      "-i", "pipe:0",     // Read from stdin
      "-vn",              // No video
      "-ab", "192k",      // Audio bitrate
      "-ar", "44100",     // Audio sample rate
      "-f", "mp3",        // Output format
      "pipe:1",           // Output to stdout
    ]);

    // Pipe yt-dlp output into ffmpeg
    ytDlp.stdout.pipe(ffmpeg.stdin);

    // Pipe ffmpeg output to the HTTP response
    ffmpeg.stdout.pipe(res);

    // Handle errors
    ytDlp.stderr.on("data", (data) => {
      console.log("yt-dlp:", data.toString());
    });

    ffmpeg.stderr.on("data", (data) => {
      // ffmpeg writes progress to stderr, which is normal
    });

    ytDlp.on("error", (err) => {
      console.error("yt-dlp spawn error:", err.message);
      if (!res.headersSent) {
        res.status(500).json({ error: "Failed to download audio." });
      }
    });

    ffmpeg.on("error", (err) => {
      console.error("ffmpeg spawn error:", err.message);
      if (!res.headersSent) {
        res.status(500).json({ error: "Failed to convert audio. Make sure FFmpeg is installed." });
      }
    });

    ytDlp.on("close", (code) => {
      if (code !== 0) {
        console.error(`yt-dlp exited with code ${code}`);
        ffmpeg.stdin.end();
      }
    });

    ffmpeg.on("close", (code) => {
      if (code !== 0) {
        console.error(`ffmpeg exited with code ${code}`);
      }
    });

    // If the client disconnects, kill the processes
    req.on("close", () => {
      ytDlp.kill();
      ffmpeg.kill();
    });
  } catch (error) {
    console.error("Download error:", error.message);
    if (!res.headersSent) {
      res.status(500).json({ error: "Failed to process download request." });
    }
  }
});

module.exports = router;
