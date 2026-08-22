# -*- coding: utf-8 -*-
"""
GPCP Version 2.3 月別長期平均降水 (mm/day) を mm/月に換算し、
共通 2 度格子の JSON へ変換する(海上を含む)。
出典: NOAA PSL, GPCP Version 2.3 Combined Precipitation Dataset, precip.mon.ltm.nc
      (https://downloads.psl.noaa.gov/Datasets/gpcp/precip.mon.ltm.nc)
      元格子 2.5x2.5 度 (144x72), 気候値期間 1991-2020, 公有データ (Adler et al. 2003 系譜)
換算: 各月の平年日数 (非閏年: 31,28,31,30,31,30,31,31,30,31,30,31) を mm/day に乗じて mm/月とした。
"""
import json
import os
import numpy as np
import netCDF4 as nc

SRC_DIR = os.path.dirname(os.path.abspath(__file__))
OUT_DIR = SRC_DIR

TARGET_H = 90
TARGET_W = 180
RES = 2.0
LON0 = -180.0

target_lat = 90.0 - (np.arange(TARGET_H) + 0.5) * RES
target_lon = LON0 + (np.arange(TARGET_W) + 0.5) * RES
target_lon_360 = np.where(target_lon < 0, target_lon + 360.0, target_lon)

DAYS_IN_MONTH = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]
MONTH_NAMES = [f"m{str(i+1).zfill(2)}" for i in range(12)]


def nearest_index(src_vals, tgt_vals):
    src_vals = np.asarray(src_vals, dtype=np.float64)
    tgt_vals = np.asarray(tgt_vals, dtype=np.float64)
    diff = np.abs(src_vals[None, :] - tgt_vals[:, None])
    return np.argmin(diff, axis=1)


def regrid(data2d, src_lat, src_lon):
    lat_idx = nearest_index(src_lat, target_lat)
    lon_idx = nearest_index(src_lon, target_lon_360)
    return data2d[np.ix_(lat_idx, lon_idx)]


def to_json_values(arr2d):
    if np.ma.isMaskedArray(arr2d):
        filled = arr2d.filled(-9999.0)
    else:
        filled = np.asarray(arr2d, dtype=np.float64)
        bad = ~np.isfinite(filled)
        filled = np.where(bad, -9999.0, filled)
    bad = ~np.isfinite(filled)
    filled = np.where(bad, -9999.0, filled)
    return filled.astype(np.float64).round(3).ravel(order="C").tolist()


def stats(flat_values):
    arr = np.array(flat_values, dtype=np.float64)
    valid = arr[arr != -9999.0]
    if valid.size == 0:
        return None
    return float(np.min(valid)), float(np.max(valid)), float(np.mean(valid))


def save_json(name, units, source, values2d):
    payload = {
        "name": name,
        "units": units,
        "source": source,
        "resolutionDeg": RES,
        "width": TARGET_W,
        "height": TARGET_H,
        "latOrder": "N2S",
        "lon0": LON0,
        "missing": -9999,
        "values": to_json_values(values2d),
    }
    path = os.path.join(OUT_DIR, f"{name}.json")
    with open(path, "w", encoding="utf-8") as f:
        json.dump(payload, f, ensure_ascii=False)
    s = stats(payload["values"])
    print(f"{name}.json  min={s[0]:.3f} max={s[1]:.3f} mean={s[2]:.3f}" if s else f"{name}.json  全欠測")
    return path


PRECIP_SRC = ("NOAA PSL, GPCP Version 2.3 Combined Precipitation Dataset, precip.mon.ltm.nc "
              "(https://downloads.psl.noaa.gov/Datasets/gpcp/precip.mon.ltm.nc), "
              "元格子 2.5x2.5 度 (144x72), 気候値期間 1991-2020, 公有データ。"
              "mm/day を平年月日数(非閏年 31,28,31,30,31,30,31,31,30,31,30,31)倍して mm/月に換算。海上を含む。")

ds = nc.Dataset(os.path.join(SRC_DIR, "precip.mon.ltm.nc"))
lat = ds.variables["lat"][:]
lon = ds.variables["lon"][:]
precip_mmday = ds.variables["precip"][:]  # (12, lat, lon), masked array, mm/day

for i in range(12):
    days = DAYS_IN_MONTH[i]
    month_mm = precip_mmday[i] * days  # masked array * scalar 保持
    save_json(f"precip_ocean_{MONTH_NAMES[i]}", "mm/month", PRECIP_SRC, regrid(month_mm, lat, lon))

# jan (m01) / jul (m07) の別名ファイルも要求仕様の命名で保存
jan_mm = precip_mmday[0] * DAYS_IN_MONTH[0]
jul_mm = precip_mmday[6] * DAYS_IN_MONTH[6]
save_json("precip_ocean_jan", "mm/month", PRECIP_SRC, regrid(jan_mm, lat, lon))
save_json("precip_ocean_jul", "mm/month", PRECIP_SRC, regrid(jul_mm, lat, lon))

ds.close()
print("完了")
