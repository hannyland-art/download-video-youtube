import { useState, useEffect } from "react";
import { getDownloadUrl, getFileUrl, getToken, getEmailStatus } from "../api";

export default function ResultsList({ results }) {
  const [downloadingId, setDownloadingId] = useState(null);
  const [progress, setProgress] = useState({ percent: 0, message: "" });
  const [emailConfigured, setEmailConfigured] = useState(false);

  // Email modal state
  const [emailModal, setEmailModal] = useState({ open: false, videoId: null, title: "" });
  const [emailAddress, setEmailAddress] = useState(() => localStorage.getItem("lastEmail") || "");
  const [emailSending, setEmailSending] = useState(false);
  
  // Toast notification state
  const [toast, setToast] = useState({ show: false, message: "", type: "success" });

  // Check if email is configured on the server
  useEffect(() => {
    getEmailStatus()
      .then((configured) => setEmailConfigured(configured))
      .catch(() => setEmailConfigured(false));
  }, []);

  if (!results || results.length === 0) return null;

  /**
   * SSE download helper — shared by both download and email flows.
   * Returns the { fileId, title } on success, or null on failure.
   */
  const runDownload = async (videoId) => {
    setDownloadingId(videoId);
    setProgress({ percent: 0, message: "Starting..." });

    try {
      const url = getDownloadUrl(videoId);
      const response = await fetch(url, {
        method: "POST",
        headers: { Authorization: `Bearer ${getToken()}` },
      });

      if (!response.ok) {
        const err = await response.json().catch(() => ({}));
        alert(err.error || "Download failed. Please try again.");
        return null;
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let fileId = null;
      let title = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const parts = buffer.split("\n\n");
        buffer = parts.pop();

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
              title = data.title || videoId;
              setProgress({ percent: 100, message: "Ready!" });
            } else if (eventType === "error") {
              alert(data.message || "Download failed.");
              return null;
            }
          } catch { /* skip malformed events */ }
        }
      }

      if (!fileId) {
        alert("Download failed. No file received.");
        return null;
      }

      return { fileId, title };

    } catch {
      alert("Download failed. Please try again.");
      return null;
    }
  };

  /**
   * Download MP3 to device
   */
  const handleDownload = async (videoId) => {
    const result = await runDownload(videoId);
    if (!result) {
      setDownloadingId(null);
      setProgress({ percent: 0, message: "" });
      return;
    }

    setProgress({ percent: 100, message: "Downloading file..." });

    try {
      const fileResponse = await fetch(getFileUrl(result.fileId), {
        method: "POST",
        headers: { Authorization: `Bearer ${getToken()}` },
      });

      if (!fileResponse.ok) {
        alert("Failed to download the file.");
        setDownloadingId(null);
        setProgress({ percent: 0, message: "" });
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

  /**
   * Open email modal for a song
   */
  const openEmailModal = (videoId, title) => {
    setEmailModal({ open: true, videoId, title });
  };

  /**
   * Close email modal
   */
  const closeEmailModal = () => {
    setEmailModal({ open: false, videoId: null, title: "" });
  };

  /**
   * Email flow: download on server and send via email directly (no client-side file download)
   */
  const handleEmailSend = async () => {
    if (!emailAddress.trim()) {
      alert("Please enter an email address.");
      return;
    }

    // Remember the email for next time
    localStorage.setItem("lastEmail", emailAddress.trim());

    const videoId = emailModal.videoId;
    closeEmailModal();

    setDownloadingId(videoId);
    setProgress({ percent: 0, message: "Starting..." });
    setEmailSending(true);

    try {
      // Pass email in request body - server will download and send email directly
      const url = getDownloadUrl(videoId);
      
      // Important: For SSE with a body, we need to ensure the request is fully sent
      // before we start reading the stream. Use AbortController to manage the connection.
      const controller = new AbortController();
      
      const response = await fetch(url, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${getToken()}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ email: emailAddress.trim() }),
        signal: controller.signal,
        // Don't cache the response
        cache: "no-cache",
      });

      if (!response.ok) {
        const err = await response.json().catch(() => ({}));
        setToast({
          show: true,
          message: err.error || "Download failed. Please try again.",
          type: "error",
        });
        setTimeout(() => setToast({ show: false, message: "", type: "error" }), 5000);
        setDownloadingId(null);
        setProgress({ percent: 0, message: "" });
        setEmailSending(false);
        return;
      }

      // Verify we have a readable stream
      if (!response.body) {
        setToast({
          show: true,
          message: "No response stream available.",
          type: "error",
        });
        setTimeout(() => setToast({ show: false, message: "", type: "error" }), 5000);
        setDownloadingId(null);
        setProgress({ percent: 0, message: "" });
        setEmailSending(false);
        return;
      }

      // Read the SSE stream for progress updates
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let emailSent = false;

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const parts = buffer.split("\n\n");
        buffer = parts.pop();

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
              emailSent = data.emailSent === true;
              if (emailSent) {
                setToast({
                  show: true,
                  message: `🎵 MP3 successfully sent to ${emailAddress.trim()}!`,
                  type: "success",
                });
                setTimeout(() => setToast({ show: false, message: "", type: "success" }), 5000);
              }
            } else if (eventType === "error") {
              setToast({
                show: true,
                message: data.message || "Failed to send email. Please try again.",
                type: "error",
              });
              setTimeout(() => setToast({ show: false, message: "", type: "error" }), 5000);
              setDownloadingId(null);
              setProgress({ percent: 0, message: "" });
              setEmailSending(false);
              return;
            }
          } catch { /* skip malformed events */ }
        }
      }

      if (!emailSent) {
        setToast({
          show: true,
          message: "Email sending failed. Please try again.",
          type: "error",
        });
        setTimeout(() => setToast({ show: false, message: "", type: "error" }), 5000);
      }

    } catch (err) {
      setToast({
        show: true,
        message: "Failed to send email. Please try again.",
        type: "error",
      });
      setTimeout(() => setToast({ show: false, message: "", type: "error" }), 5000);
    }

    setEmailSending(false);
    setDownloadingId(null);
    setProgress({ percent: 0, message: "" });
  };

  return (
    <div className="results-list">
      <h2>Search Results</h2>

      {/* Toast Notification */}
      {toast.show && (
        <div className={`toast toast-${toast.type}`}>
          <div className="toast-content">
            <span className="toast-icon">
              {toast.type === "success" ? "✓" : "✕"}
            </span>
            <span className="toast-message">{toast.message}</span>
            <button
              className="toast-close"
              onClick={() => setToast({ show: false, message: "", type: toast.type })}
            >
              ×
            </button>
          </div>
        </div>
      )}

      {downloadingId && (
        <div className="progress-container">
          <div className="progress-text">
            {emailSending ? "Sending email..." : progress.message}
          </div>
          <div className="progress-bar-track">
            <div
              className="progress-bar-fill"
              style={{ width: `${progress.percent}%` }}
            />
          </div>
          <div className="progress-percent">{progress.percent}%</div>
        </div>
      )}

      {/* Email Modal */}
      {emailModal.open && (
        <div className="email-modal-overlay" onClick={closeEmailModal}>
          <div className="email-modal" onClick={(e) => e.stopPropagation()}>
            <h3>Send MP3 by Email</h3>
            <p className="email-modal-song">{emailModal.title}</p>
            <input
              type="email"
              className="email-input"
              placeholder="Enter email address"
              value={emailAddress}
              onChange={(e) => setEmailAddress(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && handleEmailSend()}
              autoFocus
            />
            <div className="email-modal-actions">
              <button className="email-cancel-btn" onClick={closeEmailModal}>
                Cancel
              </button>
              <button className="email-send-btn" onClick={handleEmailSend}>
                Send
              </button>
            </div>
          </div>
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
              <div className="card-actions">
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
                {emailConfigured && (
                  <button
                    className="email-btn"
                    disabled={downloadingId !== null}
                    onClick={() => openEmailModal(video.videoId, video.title)}
                    title="Send MP3 by email"
                  >
                    {downloadingId === video.videoId && emailSending
                      ? "Sending..."
                      : "📧 Email"}
                  </button>
                )}
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
