import hashlib
import json
import time
from pathlib import Path

CACHE_FILE = Path.home() / ".squeezr" / "cache.json"


class CompressionCache:
    def __init__(self, max_entries: int = 1000):
        self._max = max_entries
        self._cache: dict = {}
        self._hits = 0
        self._misses = 0
        self._load()

    def _key(self, text: str) -> str:
        return hashlib.md5(text.encode("utf-8")).hexdigest()

    def get(self, text: str) -> str | None:
        entry = self._cache.get(self._key(text))
        if entry:
            entry["hits"] = entry.get("hits", 0) + 1
            self._hits += 1
            return entry["compressed"]
        self._misses += 1
        return None

    def set(self, text: str, compressed: str):
        if len(self._cache) >= self._max:
            oldest_key = min(self._cache, key=lambda k: self._cache[k].get("ts", 0))
            del self._cache[oldest_key]
        self._cache[self._key(text)] = {"compressed": compressed, "ts": time.time(), "hits": 0}
        self._persist()

    def stats(self) -> dict:
        total = self._hits + self._misses
        hit_rate = round(self._hits / max(total, 1) * 100, 1)
        return {"size": len(self._cache), "hits": self._hits, "misses": self._misses, "hit_rate_pct": hit_rate}

    def _load(self):
        try:
            if CACHE_FILE.exists():
                self._cache = json.loads(CACHE_FILE.read_text(encoding="utf-8"))
        except Exception:
            self._cache = {}

    def _persist(self):
        try:
            CACHE_FILE.parent.mkdir(parents=True, exist_ok=True)
            CACHE_FILE.write_text(json.dumps(self._cache), encoding="utf-8")
        except Exception:
            pass
