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

export function getFileUrl(fileId) {
  return `${API_BASE}/download/file/${encodeURIComponent(fileId)}`;
}

export async function getEmailStatus() {
  const response = await axios.get(`${API_BASE}/email/status`, {
    headers: { Authorization: `Bearer ${authToken}` },
  });
  return response.data.configured;
}

export async function sendEmail(fileId, email) {
  const response = await axios.post(`${API_BASE}/email`, { fileId, email }, {
    headers: { Authorization: `Bearer ${authToken}` },
  });
  return response.data;
}
