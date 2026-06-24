"""
Auto-doctor-fix: direct file-based approach. No library scan needed.
Reads paper IDs from the doctor report, then applies fixes.
"""
import json
import subprocess
import time
from datetime import datetime
from pathlib import Path

BASE = "http://localhost:5177"
DATA_DIR = Path(__file__).resolve().parent.parent / "data"
LOG_FILE = DATA_DIR / "auto-doctor-log.jsonl"
REPORT_FILE = DATA_DIR / "doctor-report.json"


def api_curl(method, path, timeout=60):
    url = f"{BASE}{path}"
    cmd = ["curl", "-s", "-X", method, "-m", str(timeout), url]
    try:
        r = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout + 10)
        if r.returncode != 0:
            return None
        return json.loads(r.stdout)
    except Exception:
        return None


def log_event(event):
    event["ts"] = datetime.now().isoformat()
    with open(LOG_FILE, "a", encoding="utf-8") as f:
        f.write(json.dumps(event, ensure_ascii=False) + "\n")


def main():
    print(f"[{datetime.now():%H:%M:%S}] Starting auto-doctor-fix...", flush=True)

    # Read doctor report directly from disk (no API call needed)
    try:
        report = json.loads(REPORT_FILE.read_text(encoding="utf-8"))
    except Exception as e:
        print(f"  ERROR reading report: {e}", flush=True)
        return

    entries = report.get("entries", [])
    need_fix = [
        e for e in entries
        if e["health"]["status"] != "ok" or e["health"]["score"] < 100
    ]
    print(f"  {len(entries)} total, {len(need_fix)} need fixes", flush=True)

    fixed = 0
    skipped = 0
    failed = 0

    for i, entry in enumerate(need_fix):
        pid = entry["id"]
        score = entry["health"]["score"]
        fname = entry.get("fileName", "")[:50]

        if entry["health"]["status"] == "readonly":
            skipped += 1
            continue

        # Dry run
        preview = api_curl("POST", f"/api/docs/{pid}/doctor/fix?dryRun=true", timeout=30)
        if not preview or "error" in (preview or {}):
            failed += 1
            log_event({"event": "preview_error", "id": pid, "error": str(preview)[:200] if preview else "null"})
            continue

        fixes = preview.get("fixes", [])
        if not fixes:
            skipped += 1
            continue

        # Apply
        result = api_curl("POST", f"/api/docs/{pid}/doctor/fix?dryRun=false", timeout=60)
        if not result or "error" in (result or {}):
            failed += 1
            log_event({"event": "fix_error", "id": pid, "error": str(result)[:200] if result else "null"})
        else:
            fixed += 1
            new_score = result.get("health", {}).get("score", "?")
            print(f"  [{i+1}/{len(need_fix)}] {fname} | {score}->{new_score} | {', '.join(fixes[:3])}", flush=True)
            log_event({"event": "fixed", "id": pid, "old_score": score, "new_score": new_score, "fixes": fixes})

        time.sleep(0.2)

    print(f"\n[{datetime.now():%H:%M:%S}] Done: fixed={fixed} skipped={skipped} failed={failed}", flush=True)
    log_event({"event": "summary", "total": len(entries), "need_fix": len(need_fix), "fixed": fixed, "skipped": skipped, "failed": failed})


if __name__ == "__main__":
    main()
