import { useState } from "react";
import { getDownloadUrl } from "../api";

export default function ResultsList({ results }) {
  const [downloadingId, setDownloadingId] = useState(null);

  if (!results || results.length === 0) return null;

  const handleDownload = async (videoId) => {
    setDownloadingId(videoId);

    try {
      const url = getDownloadUrl(videoId);
      const response = await fetch(url);

      if (!response.ok) {
        const err = await response.json().catch(() => ({}));
        alert(err.error || "Download failed. Please try again.");
        setDownloadingId(null);
        return;
      }

      // Get filename from Content-Disposition header if available
      const disposition = response.headers.get("Content-Disposition");
      let filename = `${videoId}.mp3`;
      if (disposition) {
        // Try filename*=UTF-8'' first (supports Unicode)
        const utf8Match = disposition.match(/filename\*=UTF-8''(.+?)(?:;|$)/);
        if (utf8Match) {
          filename = decodeURIComponent(utf8Match[1]);
        } else {
          const match = disposition.match(/filename="?(.+?)"?(?:;|$)/);
          if (match) filename = decodeURIComponent(match[1]);
        }
      }

      const blob = await response.blob();
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
  };

  return (
    <div className="results-list">
      <h2>Search Results</h2>
      {downloadingId && (
        <div className="download-message">
          Please wait, downloading and converting to MP3...
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
