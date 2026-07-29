# -*- coding: utf-8 -*-
"""VTT 自動字幕 → 重複除去したプレーンテキスト。
使い方: python scripts/clean_vtt.py in.vtt out.txt
"""
import re
import sys


def clean(path_in: str, path_out: str) -> None:
    lines = []
    seen_last = ""
    with open(path_in, encoding="utf-8") as f:
        for raw in f:
            line = raw.strip()
            if not line or "-->" in line or line.startswith(("WEBVTT", "Kind:", "Language:")):
                continue
            line = re.sub(r"<[^>]+>", "", line).strip()
            if not line or line == seen_last:
                continue
            seen_last = line
            lines.append(line)
    out = []
    for ln in lines:
        if out and (ln == out[-1] or out[-1].endswith(ln)):
            continue
        out.append(ln)
    with open(path_out, "w", encoding="utf-8") as f:
        f.write("\n".join(out))
    print(path_out, len(out), "lines")


if __name__ == "__main__":
    clean(sys.argv[1], sys.argv[2])
