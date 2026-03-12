import axios from "axios";

const API_BASE = "/api";

export async function searchSongs(query) {
  const response = await axios.post(`${API_BASE}/search`, { query });
  return response.data.results;
}

export function getDownloadUrl(videoId) {
  return `${API_BASE}/download/${encodeURIComponent(videoId)}`;
}
