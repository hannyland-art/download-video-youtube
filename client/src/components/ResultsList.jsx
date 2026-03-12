import { getDownloadUrl } from "../api";

export default function ResultsList({ results }) {
  if (!results || results.length === 0) return null;

  const handleDownload = (videoId, title) => {
    const url = getDownloadUrl(videoId);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${title}.mp3`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  };

  return (
    <div className="results-list">
      <h2>Search Results</h2>
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
                onClick={() => handleDownload(video.videoId, video.title)}
              >
                Download MP3
              </button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
