const express = require("express");
const { spawn } = require("child_process");
const path = require("path");
const fs = require("fs");
const os = require("os");
const crypto = require("crypto");
const ffmpegPath = require("ffmpeg-static");

// Import email function - handle case where it might not be available
let sendEmailWithFile;
try {
  const emailModule = require("./email");
  sendEmailWithFile = emailModule.sendEmailWithFile;
  if (!sendEmailWithFile) {
    console.warn("Warning: sendEmailWithFile not found in email module");
  }
} catch (err) {
  console.error("Failed to import email module:", err.message);
}

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
 * @param {boolean} [useProxy=true] — pass false to skip the proxy for this call
 */
function getCommonArgs(useProxy = true) {
  const args = [
    "--ffmpeg-location", ffmpegPath,
    "--js-runtimes", `node:${nodePath}`,
    "--cache-dir", path.join(os.homedir(), ".cache", "yt-dlp"),
  ];
  if (fs.existsSync(cookiesPath)) args.push("--cookies", cookiesPath);
  if (proxyUrl && useProxy) args.push("--proxy", proxyUrl);
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
  console.log("=== DOWNLOAD ROUTE CALLED ===");
  console.log("Method:", req.method);
  console.log("URL:", req.url);
  console.log("Headers:", JSON.stringify(req.headers));
  console.log("Body type:", typeof req.body);
  console.log("Body:", JSON.stringify(req.body));
  
  const { videoId } = req.params;
  
  // Wait for body to be fully parsed (Express.json() should have done this, but ensure it's ready)
  // If body exists, ensure it's fully available before proceeding
  const email = req.body?.email;
  
  console.log("Extracted videoId:", videoId);
  console.log("Extracted email:", email);
  console.log("Request body fully parsed:", req.body !== undefined);

  if (!videoId || typeof videoId !== "string") {
    console.error("Invalid videoId:", videoId);
    return res.status(400).json({ error: "A valid videoId is required." });
  }

  // Set up SSE headers AFTER body is confirmed parsed
  // Don't flush headers immediately - wait a tick to ensure everything is ready
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  
  // Small delay to ensure request is fully processed before starting SSE
  await new Promise(resolve => setImmediate(resolve));
  
  res.flushHeaders();
  console.log("SSE headers flushed");

  const sendEvent = (event, data) => {
    try {
      if (res.destroyed || res.finished) {
        console.warn("Cannot send SSE event - response stream closed");
        return;
      }
      const message = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
      res.write(message);
      // Don't flush immediately - let Node.js handle buffering
      // Flushing can cause issues on some systems
    } catch (err) {
      console.error("SSE write error:", err.message);
    }
  };

  const tempId = crypto.randomBytes(8).toString("hex");
  const tempFile = path.join(os.tmpdir(), `yt-mp3-${tempId}.mp3`);
  let aborted = false;
  let ytDlpProc = null;

  req.on("close", () => {
    console.log("Request closed by client");
    aborted = true;
    if (ytDlpProc) {
      try { 
        console.log("Killing yt-dlp process due to client disconnect");
        ytDlpProc.kill(); 
      } catch (err) { 
        console.error("Error killing process on client disconnect:", err.message);
      }
    }
  });
  
  req.on("aborted", () => {
    console.log("Request aborted");
    aborted = true;
  });
  
  res.on("close", () => {
    console.log("Response stream closed");
  });
  
  res.on("finish", () => {
    console.log("Response stream finished");
  });
  
  res.on("error", (err) => {
    console.error("Response stream error:", err.message);
  });

  try {
    console.log("Entered try block, videoId:", videoId, "email:", email);
    const url = `https://www.youtube.com/watch?v=${videoId}`;
    console.log("URL constructed:", url);

    // Title file — yt-dlp will write the title here during the same process
    const titleFile = path.join(os.tmpdir(), `yt-title-${tempId}.txt`);
    console.log("Title file path:", titleFile);

    sendEvent("progress", { phase: "info", percent: 0, message: "Starting download..." });
    console.log("Sent initial progress event");

    // --- Download and convert with progress (with retry) ---
    console.log("About to start download loop, email mode:", !!email);
    // Title is extracted by --print-to-file in the SAME yt-dlp process that downloads.
    //
    // Proxy problem: rotating residential proxies give a different IP for each
    // TCP connection. YouTube signs download URLs to the IP that fetched the info,
    // so a different IP on the download request → 403.
    //
    // Solution: try WITHOUT proxy first (fast & reliable when the server IP is
    // not blocked). If that fails, fall back to proxy with player clients that
    // may return HLS (m3u8) URLs which are NOT IP-locked.
    const DL_TIMEOUT = 10 * 60 * 1000; // 10 min per attempt

    console.log("Building strategies array, proxyUrl:", proxyUrl ? "set" : "not set");
    let strategies;
    try {
      strategies = proxyUrl
        ? [
            // 1. Direct (no proxy) — fastest; works when server IP isn't blocked
            { format: "ba/b", extraArgs: [], useProxy: false },
            // 2. Proxy + iOS client → tends to return HLS URLs (not IP-locked)
            { format: "ba[protocol=m3u8_native]/ba[protocol=m3u8]/ba/b",
              extraArgs: ["--extractor-args", "youtube:player_client=ios", "--hls-prefer-native"],
              useProxy: true },
            // 3. Proxy + default clients (last resort)
            { format: "ba/b", extraArgs: [], useProxy: true },
          ]
        : [
            // No proxy configured — just try different player clients
            { format: "ba/b", extraArgs: [], useProxy: false },
            { format: "ba/b", extraArgs: ["--extractor-args", "youtube:player_client=ios"], useProxy: false },
            { format: "ba/b", extraArgs: ["--extractor-args", "youtube:player_client=web"], useProxy: false },
          ];
      console.log("Strategies array built successfully, count:", strategies.length);
    } catch (err) {
      console.error("Error building strategies array:", err.message, err.stack);
      sendEvent("error", { message: "Failed to initialize download strategies." });
      res.end();
      return;
    }

    let actualFile = null;
    let title = videoId;
    let lastError = "";

    console.log("Starting download loop, strategies count:", strategies.length);
    for (let attempt = 0; attempt < strategies.length; attempt++) {
      console.log(`Loop iteration ${attempt + 1}/${strategies.length}`);
      if (aborted) { cleanupFile(tempFile); cleanupFile(titleFile); return; }

      const strategy = strategies[attempt];
      if (attempt > 0) {
        sendEvent("progress", { phase: "retrying", percent: 5, message: `Retry ${attempt}/${strategies.length - 1}... trying different method` });
        cleanupFile(tempFile); // clean partial file from previous attempt
      }

      const attemptArgs = getCommonArgs(strategy.useProxy);

      let dlExitCode = -1;
      let dlStderr = "";
      let timedOut = false;

      console.log(`Attempt ${attempt + 1}: format="${strategy.format}", proxy=${strategy.useProxy}, extraArgs=[${strategy.extraArgs.join(", ")}]`);

      const spawnArgs = [
        ...attemptArgs,
        ...strategy.extraArgs,
        url,
        "-f", strategy.format,
        "-x",
        "--audio-format", "mp3",
        "--audio-quality", "192K",
        "-o", tempFile,
        "--print-to-file", "%(title)s", titleFile,  // capture title from same process
        "--no-playlist",
        "--no-part",
        "--force-overwrites",
        "--newline",
      ];
      console.log("Spawning yt-dlp with args:", spawnArgs.join(" "));
      console.log("yt-dlp path:", ytDlpPath);
      console.log("tempFile:", tempFile);
      
      // Check if executable exists before spawning
      if (!fs.existsSync(ytDlpPath)) {
        console.error("yt-dlp executable not found at:", ytDlpPath);
        sendEvent("error", { message: "yt-dlp executable not found" });
        res.end();
        return;
      }
      
      await new Promise((resolve) => {
        try {
          console.log("About to spawn process...");
          console.log("Response writable:", res.writable);
          console.log("Response destroyed:", res.destroyed);
          console.log("Response finished:", res.finished);
          console.log("Aborted flag:", aborted);
          
          // Attach event handlers BEFORE spawning to ensure they're ready
          let processExited = false;
          
          ytDlpProc = spawn(ytDlpPath, spawnArgs, {
            stdio: ['ignore', 'pipe', 'pipe'],
            detached: false,
            windowsHide: true,
          });
          
          console.log("yt-dlp process spawned, PID:", ytDlpProc.pid);
          console.log("Process stdin:", ytDlpProc.stdin ? "exists" : "null");
          console.log("Process stdout:", ytDlpProc.stdout ? "exists" : "null");
          console.log("Process stderr:", ytDlpProc.stderr ? "exists" : "null");
          console.log("Process killed:", ytDlpProc.killed);
          console.log("Process signalCode:", ytDlpProc.signalCode);
          console.log("Process exitCode:", ytDlpProc.exitCode);
          
          // Check process state immediately
          if (ytDlpProc.killed) {
            console.error("Process was killed immediately after spawn!");
            dlExitCode = -1;
            dlStderr = "Process was killed immediately";
            resolve();
            return;
          }
          
          if (ytDlpProc.exitCode !== null) {
            console.error("Process exited immediately with code:", ytDlpProc.exitCode);
            dlExitCode = ytDlpProc.exitCode;
            resolve();
            return;
          }
          
          // Check if process is still running immediately after spawn
          setTimeout(() => {
            if (ytDlpProc) {
              console.log("After 100ms - Process killed:", ytDlpProc.killed);
              console.log("After 100ms - Process exitCode:", ytDlpProc.exitCode);
              console.log("After 100ms - Process signalCode:", ytDlpProc.signalCode);
              if (ytDlpProc.killed === false && ytDlpProc.exitCode === null) {
                console.log("Process still running after 100ms");
              } else {
                console.log("Process already killed/exited after 100ms");
              }
            } else {
              console.log("After 100ms - Process is null (was cleaned up)");
            }
          }, 100);
        } catch (err) {
          console.error("Failed to spawn yt-dlp:", err.message, err.stack);
          dlExitCode = -1;
          resolve();
          return;
        }

        ytDlpProc.stdout.on("data", (data) => {
          console.log("stdout data received, length:", data.length);
          const text = data.toString();
          console.log("yt-dlp stdout:", text.trim());
          const match = text.match(/\[download\]\s+([\d.]+)%/);
          if (match && !aborted) {
            console.log("match1", match);
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
          console.error("yt-dlp stderr data received:", text.trim());
          const match = text.match(/\[download\]\s+([\d.]+)%/);
          if (match && !aborted) {
            const dlPercent = parseFloat(match[1]);
            const overall = Math.round(5 + (dlPercent * 0.75));
            sendEvent("progress", { phase: "downloading", percent: overall, message: `Downloading... ${Math.round(dlPercent)}%` });
          }
        });
        
        // Also listen for stderr end event to catch any buffered output
        ytDlpProc.stderr.on("end", () => {
          console.log("yt-dlp stderr stream ended");
        });

        ytDlpProc.stderr.on("error", (err) => {
          console.error("yt-dlp stderr stream error:", err.message);
        });

        ytDlpProc.stdout.on("error", (err) => {
          console.error("yt-dlp stdout stream error:", err.message);
        });

        ytDlpProc.on("error", (err) => {
          console.error("yt-dlp process error event:", err.message, err.stack);
          dlExitCode = -1;
          dlStderr += err.message;
          resolve();
        });
        
        // Handle exit event (fires before close)
        ytDlpProc.on("exit", (code, signal) => {
          console.log(`yt-dlp process exited with code: ${code}, signal: ${signal}`);
          if (code === null && signal) {
            console.error(`Process was killed by signal: ${signal}`);
            dlStderr += `Process killed by signal: ${signal}`;
          }
        });
        
        ytDlpProc.on("close", (code, signal) => {
          console.log(`yt-dlp process closed with code: ${code}, signal: ${signal}`);
          if (code === null) {
            console.error("Process closed with null code - likely killed unexpectedly");
            dlStderr += "Process was killed unexpectedly";
          }
          dlExitCode = code !== null ? code : -1;
          resolve();
        });

        setTimeout(() => {
          if (!timedOut) {
            timedOut = true;
            console.log("Download timeout reached, killing process");
            try { 
              if (ytDlpProc && !ytDlpProc.killed) {
                ytDlpProc.kill();
              }
            } catch (err) { 
              console.error("Error killing process:", err.message);
            }
            resolve();
          }
        }, DL_TIMEOUT);
      });
      
      console.log("Promise resolved, exitCode:", dlExitCode, "timedOut:", timedOut);

      console.log("match1", 123);
      ytDlpProc = null;

      if (aborted) { cleanupFile(tempFile); cleanupFile(titleFile); return; }

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

      if (actualFile) {
        // Read title from the file written by --print-to-file
        try {
          if (fs.existsSync(titleFile)) {
            title = fs.readFileSync(titleFile, "utf-8").trim() || videoId;
          }
        } catch { /* use videoId as fallback */ }
        break; // success!
      }

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
      sendEvent("error", { message: `Download failed after ${strategies.length} attempts: ${lastError}` });
      cleanupFile(tempFile);
      cleanupFile(titleFile);
      res.end();
      return;
    }
console.log("actualFile", actualFile);
    // Clean up the title temp file
    cleanupFile(titleFile);

    // If email is provided, send email directly without storing file
    if (email) {
      if (!sendEmailWithFile) {
        console.error("sendEmailWithFile is not available");
        sendEvent("error", { message: "Email functionality is not configured on the server." });
        cleanupFile(actualFile);
        res.end();
        return;
      }

      sendEvent("progress", { phase: "sending", percent: 95, message: "Sending email..." });
      console.log("About to send email with file:", actualFile, "to:", email);
      try {
        await sendEmailWithFile(actualFile, title, email);
        console.log("Email sent successfully");
        sendEvent("progress", { phase: "done", percent: 100, message: "Email sent!" });
        sendEvent("done", { emailSent: true, title });
        // Clean up the file immediately after sending email
        cleanupFile(actualFile);
      } catch (err) {
        console.error("Email send error:", err.message, err.stack);
        sendEvent("error", { message: `Failed to send email: ${err.message}` });
        cleanupFile(actualFile);
      }
      res.end();
      return;
    }

    // Otherwise, store the file for retrieval
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
    cleanupFile(path.join(os.tmpdir(), `yt-title-${tempId}.txt`));
    if (!aborted) {
      sendEvent("error", { message: "Failed to process download request." });
      res.end();
    }
  }
});

module.exports = router;
module.exports.completedFiles = completedFiles;