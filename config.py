import os
import sys
from pathlib import Path

TOML_FILE = Path(__file__).parent / "squeezr.toml"


def _load_toml() -> dict:
    if not TOML_FILE.exists():
        return {}
    try:
        content = TOML_FILE.read_text(encoding="utf-8")
        if sys.version_info >= (3, 11):
            import tomllib
            return tomllib.loads(content)
        else:
            import tomli
            return tomli.loads(content)
    except Exception:
        return {}


class Config:
    def __init__(self):
        t = _load_toml()
        proxy = t.get("proxy", {})
        comp = t.get("compression", {})
        cache_cfg = t.get("cache", {})
        adaptive_cfg = t.get("adaptive", {})

        # Proxy
        self.port = int(os.environ.get("SQUEEZR_PORT", proxy.get("port", 8080)))

        # Compression
        self.threshold = int(os.environ.get("SQUEEZR_THRESHOLD", comp.get("threshold", 800)))
        self.keep_recent = int(os.environ.get("SQUEEZR_KEEP_RECENT", comp.get("keep_recent", 3)))
        self.disabled = os.environ.get("SQUEEZR_DISABLED", str(comp.get("disabled", False))).lower() in ("1", "true")
        self.compress_system_prompt = comp.get("compress_system_prompt", True)
        self.compress_conversation = comp.get("compress_conversation", False)

        # Dry-run
        self.dry_run = os.environ.get("SQUEEZR_DRY_RUN", "").lower() in ("1", "true")

        # Cache
        self.cache_enabled = cache_cfg.get("enabled", True)
        self.cache_max_entries = int(cache_cfg.get("max_entries", 1000))

        # Adaptive thresholds
        self.adaptive_enabled = adaptive_cfg.get("enabled", True)
        self.adaptive_low = int(adaptive_cfg.get("low_threshold", 1500))
        self.adaptive_mid = int(adaptive_cfg.get("mid_threshold", 800))
        self.adaptive_high = int(adaptive_cfg.get("high_threshold", 400))
        self.adaptive_critical = int(adaptive_cfg.get("critical_threshold", 150))

        # Local / Ollama
        local_cfg = t.get("local", {})
        self.local_enabled = local_cfg.get("enabled", True)
        self.local_upstream_url = os.environ.get(
            "SQUEEZR_LOCAL_UPSTREAM", local_cfg.get("upstream_url", "http://localhost:11434")
        )
        self.local_compression_model = os.environ.get(
            "SQUEEZR_LOCAL_MODEL", local_cfg.get("compression_model", "qwen2.5-coder:1.5b")
        )
        raw_dummy = local_cfg.get("dummy_keys", ["ollama", "lm-studio", "sk-no-key-required", "local", "none", ""])
        self.local_dummy_keys = {k.lower() for k in raw_dummy}

    def is_local_key(self, key: str) -> bool:
        """Returns True if the auth key looks like a local/dummy key."""
        if not self.local_enabled:
            return False
        k = key.strip().lower()
        return k in self.local_dummy_keys or (k and not k.startswith("sk-") and not k.startswith("aiza"))

    def threshold_for_pressure(self, pressure: float) -> int:
        """Returns compression threshold based on context pressure (0.0-1.0)."""
        if not self.adaptive_enabled:
            return self.threshold
        if pressure >= 0.90:
            return self.adaptive_critical
        if pressure >= 0.75:
            return self.adaptive_high
        if pressure >= 0.50:
            return self.adaptive_mid
        return self.adaptive_low
