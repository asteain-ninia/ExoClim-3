#!/usr/bin/env bash
# 一次参照動画の自動字幕を一括取得し、docs/動画書き起こし/ に整形保存する。
# 実行: bash scripts/fetch_transcripts.sh
set -u
OUT="docs/動画書き起こし"
TMP="${TMPDIR:-/tmp}/exoclim_subs"
mkdir -p "$OUT" "$TMP"

fetch() {
  local id="$1"
  local name="$2"
  if [ -f "$OUT/${name}_自動字幕.txt" ]; then
    echo "skip $name (exists)"
    return
  fi
  echo "=== $name ($id)"
  python -m yt_dlp --skip-download --write-auto-sub --sub-lang "en.*" --sub-format vtt \
    -o "$TMP/${name}.%(ext)s" "https://www.youtube.com/watch?v=${id}" >/dev/null 2>&1
  local vtt
  vtt=$(ls "$TMP/${name}".en*.vtt 2>/dev/null | head -1)
  if [ -n "${vtt:-}" ]; then
    PYTHONIOENCODING=utf-8 python scripts/clean_vtt.py "$vtt" "$OUT/${name}_自動字幕.txt"
  else
    echo "!! captions not found for $name"
  fi
  sleep 2
}

# Artifexian — Worldbuilder's Log シリーズ(気候関連の全回)
# 注: 旧 ExoClim-2 の INTENT はこのシリーズを Worldbuilding Pasta 名義と誤帰属していた。
# 実チャンネルは Artifexian(Pasta ブログ + Madeline James の手法で実演する動画)。
fetch UgJ67AswrEs "WL28_OceanCurrents"
fetch gWYzAFi0MZ4 "WL29_WindsPressure"
fetch vmoed42Zivg "WL30_UpwellingCoralReefs"
fetch lHV-jZUB5WU "WL31_Precipitation"
fetch 2RMyd9vo2Qk "WL32_PrecipPressureRedo"
fetch 0yzTeuOZZ6o "WL33_TempContinentality"
fetch Ihwv2EduEoM "WL34_TempIsotherms"
fetch bTWF-xl_R0A "WL35_TempFinalMaps"
fetch uSMcnZV_Hh0 "WL36_PolarClimates"
fetch vi66amwP2g0 "WL37_TropicalClimates"
fetch e1EEKnliSK8 "WL38_AridClimates"
fetch BvZ1rlCLg8U "WL39_TemperateClimates"
fetch CYaHD9IKb2g "WL40_ContinentalClimates"
# Artifexian — 単発チュートリアル
fetch n_E9UShtyY8 "Artifexian_OceanCurrents"
fetch 5lCbxMZJ4zA "Artifexian_RealisticClimates1"
fetch fag48Nh8PXE "Artifexian_RealisticClimates2"
fetch cnKUbcVrZVg "Artifexian_HotColdPlanets"
fetch RNfrYrIl9o8 "Artifexian_RetrogradeClimates"

echo "done"
