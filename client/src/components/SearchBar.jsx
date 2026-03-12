import { useState } from "react";

export default function SearchBar({ onSearch, isLoading }) {
  const [query, setQuery] = useState("");

  const handleSubmit = (e) => {
    e.preventDefault();
    if (query.trim()) {
      onSearch(query.trim());
    }
  };

  return (
    <form className="search-bar" onSubmit={handleSubmit}>
      <input
        type="text"
        placeholder="Enter a song name..."
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        disabled={isLoading}
      />
      <button type="submit" disabled={isLoading || !query.trim()}>
        {isLoading ? "Searching..." : "Search"}
      </button>
    </form>
  );
}
