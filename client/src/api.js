import axios from "axios";

const API_BASE = "/api";

let authToken = null;

export function setToken(token) {
  authToken = token;
}

export function getToken() {
  return authToken;
}

export async function searchSongs(query) {
  const response = await axios.post(`${API_BASE}/search`, { query }, {
    headers: { Authorization: `Bearer ${authToken}` },
  });
  return response.data.results;
}

export function getDownloadUrl(videoId) {
  return `${API_BASE}/download/${encodeURIComponent(videoId)}`;
}
