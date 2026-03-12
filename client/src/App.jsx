import { useState } from "react";
import SearchBar from "./components/SearchBar";
import ResultsList from "./components/ResultsList";
import { searchSongs } from "./api";
import "./App.css";

function App() {
  const [results, setResults] = useState([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState("");

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
      setError(
        err.response?.data?.error || "Something went wrong. Please try again."
      );
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div className="app">
      <header className="app-header">
        <h1>YouTube MP3 Downloader</h1>
        <p>Search for a song and download it as MP3</p>
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
