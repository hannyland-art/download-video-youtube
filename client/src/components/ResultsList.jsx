import { useState } from "react";
import { getDownloadUrl, getFileUrl, getToken } from "../api";

export default function ResultsList({ results }) {
  const [downloadingId, setDownloadingId] = useState(null);
  const [progress, setProgress] = useState({ percent: 0, message: "" });

  if (!results || results.length === 0) return null;

  const handleDownload = async (videoId) => {
    setDownloadingId(videoId);
    setProgress({ percent: 0, message: "Starting..." });

    try {
      // Phase 1: Connect to SSE progress stream
      const url = getDownloadUrl(videoId);
      const response = await fetch(url, {
        headers: { Authorization: `Bearer ${getToken()}` },
      });

      if (!response.ok) {
        const err = await response.json().catch(() => ({}));
        alert(err.error || "Download failed. Please try again.");
        setDownloadingId(null);
        return;
      }

      // Read the SSE stream
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let fileId = null;

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });

        // Parse SSE events from buffer
        const parts = buffer.split("\n\n");
        buffer = parts.pop(); // Keep incomplete part in buffer

        for (const part of parts) {
          const lines = part.split("\n");
          let eventType = "";
          let eventData = "";

          for (const line of lines) {
            if (line.startsWith("event: ")) eventType = line.slice(7);
            if (line.startsWith("data: ")) eventData = line.slice(6);
          }

          if (!eventData) continue;

          try {
            const data = JSON.parse(eventData);

            if (eventType === "progress") {
              setProgress({ percent: data.percent || 0, message: data.message || "" });
            } else if (eventType === "done") {
              fileId = data.fileId;
              setProgress({ percent: 100, message: "Downloading file..." });
            } else if (eventType === "error") {
              alert(data.message || "Download failed.");
              setDownloadingId(null);
              return;
            }
          } catch { /* skip malformed events */ }
        }
      }

      if (!fileId) {
        alert("Download failed. No file received.");
        setDownloadingId(null);
        return;
      }

      // Phase 2: Download the completed MP3 file
      const fileResponse = await fetch(getFileUrl(fileId), {
        headers: { Authorization: `Bearer ${getToken()}` },
      });

      if (!fileResponse.ok) {
        alert("Failed to download the file.");
        setDownloadingId(null);
        return;
      }

      const disposition = fileResponse.headers.get("Content-Disposition");
      let filename = `${videoId}.mp3`;
      if (disposition) {
        const utf8Match = disposition.match(/filename\*=UTF-8''(.+?)(?:;|$)/);
        if (utf8Match) {
          filename = decodeURIComponent(utf8Match[1]);
        } else {
          const match = disposition.match(/filename="?(.+?)"?(?:;|$)/);
          if (match) filename = decodeURIComponent(match[1]);
        }
      }

      const blob = await fileResponse.blob();
      const blobUrl = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = blobUrl;
      a.download = filename;
      a.style.display = "none";
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(blobUrl);

    } catch {
      alert("Download failed. Please try again.");
    }

    setDownloadingId(null);
    setProgress({ percent: 0, message: "" });
  };

  return (
    <div className="results-list">
      <h2>Search Results</h2>

      {downloadingId && (
        <div className="progress-container">
          <div className="progress-text">{progress.message}</div>
          <div className="progress-bar-track">
            <div
              className="progress-bar-fill"
              style={{ width: `${progress.percent}%` }}
            />
          </div>
          <div className="progress-percent">{progress.percent}%</div>
        </div>
      )}

      <div className="results-grid">
        {results.map((video, index) => (
          <div className="result-card" key={video.videoId || index}>
            <div className="thumbnail-wrapper">
              <img
                src={video.thumbnail}
                alt={video.title}
                className="thumbnail"
              />
              <span className="duration">{video.duration}</span>
            </div>
            <div className="card-info">
              <h3 className="video-title" title={video.title}>
                {video.title}
              </h3>
              <p className="channel-name">{video.channel}</p>
              <button
                className="download-btn"
                disabled={downloadingId !== null}
                onClick={() => handleDownload(video.videoId)}
              >
                {downloadingId === video.videoId
                  ? "Downloading..."
                  : downloadingId !== null
                  ? "Please wait..."
                  : "Download MP3"}
              </button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
