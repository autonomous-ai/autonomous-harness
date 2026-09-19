"""Fetch reviewed source pins without installing services or changing user configuration."""
import json
import os
from pathlib import Path
import re
import subprocess


def fetch_sources(root):
    root = Path(root).resolve()
    sources = json.loads((root / "upstream.lock.json").read_text())
    for source in sources:
        directory = source["directory"]
        if not re.fullmatch(r"[a-zA-Z0-9][a-zA-Z0-9._-]*", directory):
            raise ValueError("Upstream directories must be package-local names")
        if not re.fullmatch(r"[0-9a-f]{40}", source["commit"]):
            raise ValueError("Upstream sources must use full commit pins")
        target = root / directory
        target.resolve().relative_to(root)
        def git(*args, quiet=False):
            return subprocess.check_output(["git", "-C", str(target), *args], text=True,
                                           stderr=subprocess.DEVNULL if quiet else None,
                                           env={**os.environ, "GIT_LFS_SKIP_SMUDGE": "1"}).strip()
        if not (target / ".git").exists():
            target.mkdir(parents=True, exist_ok=True)
            git("init", "-q")
            git("remote", "add", "origin", source["url"])
            if source.get("sparse"):
                git("sparse-checkout", "init", "--cone")
        if git("remote", "get-url", "origin") != source["url"]:
            raise SystemExit(f"Unexpected upstream remote in {target}")
        try:
            current = git("rev-parse", "--verify", "HEAD", quiet=True)
        except subprocess.CalledProcessError:
            current = ""
        if current != source["commit"] and current and git("status", "--porcelain"):
            raise SystemExit(f"Save your edits in {target} before changing its source pin")
        if source.get("sparse"):
            git("sparse-checkout", "set", *source["sparse"])
        if current != source["commit"]:
            git("fetch", "--quiet", "--depth", "1", "--filter=blob:none", "origin", source["commit"])
            git("checkout", "--quiet", "--detach", source["commit"])
        print(f'ok {source["name"]} at {source["commit"][:12]}', flush=True)


if __name__ == "__main__":
    fetch_sources(Path(__file__).resolve().parent.parent)
