#!/usr/bin/env python3
"""
squeezr gain — show token savings statistics.
Usage: python gain.py [--reset]
"""
import json
import sys
import urllib.request
import urllib.error
import os

from stats import Stats, efficiency_bar, chars_to_tokens, STATS_FILE

PORT = int(os.environ.get("SQUEEZR_PORT", "8080"))
WIDTH = 60


def h_line(char="\u2550"):
    return char * WIDTH


def fetch_live_stats() -> dict | None:
    try:
        with urllib.request.urlopen(f"http://localhost:{PORT}/squeezr/stats", timeout=2) as resp:
            return json.loads(resp.read())
    except Exception:
        return None


def load_file_stats() -> dict:
    return Stats.load_global()


def render(data: dict, source: str):
    total_saved_chars = data.get("total_saved_chars", 0)
    total_original = data.get("total_original_chars", 0)
    total_saved_tokens = data.get("total_saved_tokens", round(chars_to_tokens(total_saved_chars)))
    savings_pct = data.get("savings_pct", round((total_saved_chars / max(total_original, 1)) * 100, 1))
    requests = data.get("requests", 0)
    compressions = data.get("compressions", 0)
    by_tool = data.get("by_tool", {})

    print()
    print(h_line())
    print(f"  Squeezr Token Savings  ({source})")
    print(h_line())
    print(f"  Total requests:    {requests}")
    print(f"  Compressions:      {compressions}")
    print(f"  Chars saved:       {total_saved_chars:,}  (~{total_saved_tokens:,} tokens)")
    print(f"  Savings:           {savings_pct}%")
    print(f"  Efficiency meter:  {efficiency_bar(savings_pct)} {savings_pct}%")
    print()

    if by_tool:
        col_w = WIDTH - 2
        header = f"  {'#':<4}{'Tool':<16}{'Count':>6}  {'Saved':>8}  {'Avg%':>5}"
        sep = "  " + "\u2500" * (col_w - 2)
        print(f"  By Tool")
        print(sep)
        print(header)
        print(sep)

        sorted_tools = sorted(by_tool.items(), key=lambda x: x[1].get("saved_chars", 0), reverse=True)
        for rank, (tool, tdata) in enumerate(sorted_tools, 1):
            saved = tdata.get("saved_chars", 0)
            avg_pct = tdata.get("avg_pct", 0)
            count = tdata.get("count", 0)
            saved_k = f"{saved/1000:.1f}K" if saved >= 1000 else str(saved)
            bar_w = round(10 * avg_pct / 100)
            bar = "\u2588" * bar_w + "\u2591" * (10 - bar_w)
            print(f"  {rank:<4}{tool:<16}{count:>6}  {saved_k:>8}  {avg_pct:>4.0f}%  {bar}")

        print(sep)

    print(h_line())
    print()


def main():
    if "--reset" in sys.argv:
        if STATS_FILE.exists():
            STATS_FILE.unlink()
            print("Stats reset.")
        else:
            print("No stats file found.")
        return

    live = fetch_live_stats()
    if live:
        render(live, source="live session")
    else:
        file_data = load_file_stats()
        if not file_data:
            print("\n  No stats yet. Start Squeezr and use Claude Code.\n")
            return
        render(file_data, source="last session")
        print(f"  [Squeezr not running — showing saved stats from {STATS_FILE}]")
        print()


if __name__ == "__main__":
    main()
