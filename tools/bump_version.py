#!/usr/bin/env python3
"""Stamp a new build version into index.html and version.json.

Run before every push. Phones compare their built-in version with version.json
and reload themselves when a newer build is live; script URLs carry ?v= so the
new files are fetched instead of cached ones.
"""
import json, re, time, pathlib
root = pathlib.Path(__file__).resolve().parent.parent
v = time.strftime("%Y%m%d%H%M%S", time.gmtime())
html = (root / "index.html").read_text()
html = re.sub(r'window\.CW_VERSION="[^"]*"', f'window.CW_VERSION="{v}"', html)
html = re.sub(r'src="(config|game|rt|app)\.js(\?v=[^"]*)?"', lambda m: f'src="{m.group(1)}.js?v={v}"', html)
(root / "index.html").write_text(html)
(root / "version.json").write_text(json.dumps({"version": v}) + "\n")
print(v)
