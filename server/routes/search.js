const express = require("express");
const YouTube = require("youtube-sr").default;
const https = require("https");
const http = require("http");

const router = express.Router();

/**
 * Fetches an image from a URL and returns it as a base64 data URI.
 * Returns an empty string if the fetch fails.
 */
function fetchImageAsBase64(url) {
  return new Promise((resolve) => {
    if (!url) return resolve("");

    const client = url.startsWith("https") ? https : http;

    client
      .get(url, (response) => {
        // Follow redirects
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
          const base64 = buffer.toString("base64");
          resolve(`data:${contentType};base64,${base64}`);
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

    const results = await YouTube.search(query.trim(), { limit: 10, type: "video" });

    // Fetch all thumbnails in parallel and convert to base64
    const videos = await Promise.all(
      results.map(async (video) => {
        const thumbnailUrl = video.thumbnail?.url || "";
        const thumbnailBase64 = await fetchImageAsBase64(thumbnailUrl);

        return {
          videoId: video.id,
          title: video.title,
          thumbnail: thumbnailBase64,
          duration: video.durationFormatted || "N/A",
          channel: video.channel?.name || "Unknown",
          url: video.url,
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
