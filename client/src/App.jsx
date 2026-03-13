import { useState, useEffect } from "react";
import LoginPage from "./components/LoginPage";
import SearchBar from "./components/SearchBar";
import ResultsList from "./components/ResultsList";
import { searchSongs, setToken } from "./api";
import "./App.css";

function App() {
  const [token, setAuthToken] = useState(null);
  const [results, setResults] = useState([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState("");
  const [autoLoginDone, setAutoLoginDone] = useState(false);

  // Auto-login on page load using saved credentials
  useEffect(() => {
    const saved = localStorage.getItem("credentials");
    if (!saved) {
      setAutoLoginDone(true);
      return;
    }

    (async () => {
      try {
        const { username, password } = JSON.parse(saved);
        const response = await fetch("/api/login", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ username, password }),
        });
        const data = await response.json();
        if (response.ok) {
          setToken(data.token);
          setAuthToken(data.token);
        } else {
          // Saved credentials are no longer valid
          localStorage.removeItem("credentials");
        }
      } catch {
        // Server unreachable, show login page
      }
      setAutoLoginDone(true);
    })();
  }, []);

  const handleLogin = (newToken, username, password) => {
    setToken(newToken);
    setAuthToken(newToken);
    // Save credentials for auto-login next time
    localStorage.setItem("credentials", JSON.stringify({ username, password }));
  };

  const handleLogout = () => {
    setToken(null);
    setAuthToken(null);
    setResults([]);
    setError("");
    localStorage.removeItem("credentials");
  };

  const handleSearch = async (query) => {
    setIsLoading(true);
    setError("");
    setResults([]);

    try {
      const data = await searchSongs(query);
      setResults(data);
      if (data.length === 0) {
        setError("No results found. Try a different search term.");
      }
    } catch (err) {
      if (err.response?.status === 401) {
        handleLogout();
        return;
      }
      setError(
        err.response?.data?.error || "Something went wrong. Please try again."
      );
    } finally {
      setIsLoading(false);
    }
  };

  // Show nothing while auto-login is in progress (avoids login page flash)
  if (!autoLoginDone) {
    return null;
  }

  if (!token) {
    return <LoginPage onLogin={handleLogin} />;
  }

  return (
    <div className="app">
      <header className="app-header">
        <h1>YouTube MP3 Downloader</h1>
        <p>Search for a song and download it as MP3</p>
        <button className="logout-btn" onClick={handleLogout}>
          Logout
        </button>
      </header>

      <main className="app-main">
        <SearchBar onSearch={handleSearch} isLoading={isLoading} />

        {error && <div className="error-message">{error}</div>}

        <ResultsList results={results} />
      </main>
    </div>
  );
}

export default App;
