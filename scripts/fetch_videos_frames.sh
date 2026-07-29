#!/usr/bin/env bash
# 残りの一次参照動画を 480p で取得し、20 秒ごとのフレームを抽出する。
# 出力: scratchpad/video/<name>.mp4, scratchpad/frames_<name>/tNNNN.jpg
set -u
SCRATCH="${SCRATCH_DIR:?SCRATCH_DIR を指定}"
mkdir -p "$SCRATCH/video"

FF=$(python -c "import imageio_ffmpeg; print(imageio_ffmpeg.get_ffmpeg_exe())")

grab() {
  local id="$1"
  local name="$2"
  local out="$SCRATCH/frames_${name}"
  if [ -d "$out" ] && [ -n "$(ls -A "$out" 2>/dev/null)" ]; then
    echo "skip $name"
    return
  fi
  echo "=== $name ($id)"
  if [ ! -f "$SCRATCH/video/${name}.mp4" ]; then
    python -m yt_dlp -f "b[height<=480]" -o "$SCRATCH/video/${name}.%(ext)s" \
      "https://www.youtube.com/watch?v=${id}" >/dev/null 2>&1
  fi
  if [ -f "$SCRATCH/video/${name}.mp4" ]; then
    mkdir -p "$out"
    "$FF" -y -i "$SCRATCH/video/${name}.mp4" -vf fps=1/20 -q:v 4 "$out/t%04d.jpg" \
      >/dev/null 2>&1
    echo "$name: $(ls "$out" | wc -l) frames"
  else
    echo "!! download failed: $name"
  fi
  sleep 2
}

grab gWYzAFi0MZ4 "WL29_WindsPressure"
grab vmoed42Zivg "WL30_Upwelling"
grab lHV-jZUB5WU "WL31_Precipitation"
grab 2RMyd9vo2Qk "WL32_PrecipRedo"
grab 0yzTeuOZZ6o "WL33_TempContinentality"
grab Ihwv2EduEoM "WL34_TempIsotherms"
grab bTWF-xl_R0A "WL35_TempFinalMaps"
grab uSMcnZV_Hh0 "WL36_PolarClimates"
grab vi66amwP2g0 "WL37_TropicalClimates"
grab e1EEKnliSK8 "WL38_AridClimates"
grab BvZ1rlCLg8U "WL39_TemperateClimates"
grab CYaHD9IKb2g "WL40_ContinentalClimates"

echo "all done"
