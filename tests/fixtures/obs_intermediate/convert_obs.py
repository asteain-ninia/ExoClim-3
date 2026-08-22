# -*- coding: utf-8 -*-
"""
NOAA PSL の月別長期平均 (ltm) netCDF を共通 2 度格子の JSON へ変換する。
出典: NOAA Physical Sciences Laboratory (downloads.psl.noaa.gov)
      NCEP/NCAR Reanalysis 1 derived products (SLP, 10m U/V wind)
      NOAA Optimum Interpolation SST V2 (SST, 海氷密接度)
気候値期間: 1991-2020 (各ファイルの climo_period 属性で確認)
ライセンス: NOAA 提供データは公有 (public domain)。
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

# 目標格子: セル中心, 緯度 90N -> 90S (北から南), 経度 -180 -> 180 (西から東)
target_lat = 90.0 - (np.arange(TARGET_H) + 0.5) * RES  # 89 .. -89
target_lon = LON0 + (np.arange(TARGET_W) + 0.5) * RES  # -179 .. 179
target_lon_360 = np.where(target_lon < 0, target_lon + 360.0, target_lon)


def nearest_index(src_vals, tgt_vals):
    """各 tgt 値に最も近い src_vals のインデックス配列を返す(総当たり、格子が小さいので十分速い)。"""
    src_vals = np.asarray(src_vals, dtype=np.float64)
    tgt_vals = np.asarray(tgt_vals, dtype=np.float64)
    diff = np.abs(src_vals[None, :] - tgt_vals[:, None])
    return np.argmin(diff, axis=1)


def regrid(data2d, src_lat, src_lon):
    """data2d: (nlat, nlon) の masked array or ndarray。src_lon は 0-360 系を想定。"""
    lat_idx = nearest_index(src_lat, target_lat)
    lon_idx = nearest_index(src_lon, target_lon_360)
    out = data2d[np.ix_(lat_idx, lon_idx)]
    return out


def to_json_values(arr2d):
    """masked array を -9999 埋めの平坦 list に変換。"""
    if np.ma.isMaskedArray(arr2d):
        filled = arr2d.filled(-9999.0)
        mask = np.ma.getmaskarray(arr2d)
    else:
        filled = np.asarray(arr2d, dtype=np.float64)
        mask = ~np.isfinite(filled)
        filled = np.where(mask, -9999.0, filled)
    # 非有限値も欠測として扱う
    bad = ~np.isfinite(filled)
    filled = np.where(bad, -9999.0, filled)
    # 仕様通り row-major の平坦 1 次元配列にして返す
    return filled.astype(np.float64).round(3).ravel(order="C").tolist()


def stats(arr2d):
    if np.ma.isMaskedArray(arr2d):
        valid = arr2d.compressed()
    else:
        valid = arr2d[np.isfinite(arr2d)]
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
    s = stats(np.ma.masked_equal(np.array(payload["values"]), -9999.0))
    print(f"{name}.json  min={s[0]:.3f} max={s[1]:.3f} mean={s[2]:.3f}" if s else f"{name}.json  全欠測")
    return path


def open_var(fname, varname):
    ds = nc.Dataset(os.path.join(SRC_DIR, fname))
    lat = ds.variables["lat"][:]
    lon = ds.variables["lon"][:]
    data = ds.variables[varname][:]  # (time, lat, lon), masked array
    return ds, lat, lon, data


# ---------------------------------------------------------------------------
# SLP (NCEP/NCAR Reanalysis 1, 2.5deg regular grid, 144x73)
SLP_SRC = ("NOAA PSL NCEP/NCAR Reanalysis 1 derived products, slp.mon.ltm.nc "
           "(https://downloads.psl.noaa.gov/Datasets/ncep.reanalysis.derived/surface/slp.mon.ltm.nc), "
           "元格子 2.5x2.5 度 (144x73), 気候値期間 1991-2020, 公有データ (Kalnay et al. 1996)")
ds, lat, lon, slp = open_var("slp.mon.ltm.nc", "slp")
save_json("slp_jan", "hPa", SLP_SRC, regrid(slp[0], lat, lon))
save_json("slp_jul", "hPa", SLP_SRC, regrid(slp[6], lat, lon))
ds.close()

# ---------------------------------------------------------------------------
# 10m U/V 風 (NCEP/NCAR Reanalysis 1, Gaussian T62 格子, 192x94)
WIND_SRC_TMPL = ("NOAA PSL NCEP/NCAR Reanalysis 1 derived products, {f} "
                  "(https://downloads.psl.noaa.gov/Datasets/ncep.reanalysis.derived/surface_gauss/{f}), "
                  "元格子 Gaussian T62 (192x94), 気候値期間 1991-2020, 公有データ (Kalnay et al. 1996)")

ds, lat, lon, uwnd = open_var("uwnd.10m.mon.ltm.nc", "uwnd")
save_json("uwnd10_jan", "m/s", WIND_SRC_TMPL.format(f="uwnd.10m.mon.ltm.nc"), regrid(uwnd[0], lat, lon))
save_json("uwnd10_jul", "m/s", WIND_SRC_TMPL.format(f="uwnd.10m.mon.ltm.nc"), regrid(uwnd[6], lat, lon))
ds.close()

ds, lat, lon, vwnd = open_var("vwnd.10m.mon.ltm.nc", "vwnd")
save_json("vwnd10_jan", "m/s", WIND_SRC_TMPL.format(f="vwnd.10m.mon.ltm.nc"), regrid(vwnd[0], lat, lon))
save_json("vwnd10_jul", "m/s", WIND_SRC_TMPL.format(f="vwnd.10m.mon.ltm.nc"), regrid(vwnd[6], lat, lon))
ds.close()

# ---------------------------------------------------------------------------
# SST (NOAA OISST V2, 1x1 度格子, 360x180)
SST_SRC = ("NOAA PSL, NOAA Optimum Interpolation SST V2, sst.ltm.nc "
           "(https://downloads.psl.noaa.gov/Datasets/noaa.oisst.v2/sst.ltm.nc), "
           "元格子 1x1 度 (360x180), 気候値期間 1991-2020, 公有データ (Reynolds et al. 2002)")
ds, lat, lon, sst = open_var("sst.ltm.nc", "sst")
save_json("sst_jan", "degC", SST_SRC, regrid(sst[0], lat, lon))
save_json("sst_jul", "degC", SST_SRC, regrid(sst[6], lat, lon))
# 年平均: 12ヶ月の単純平均 (各月とも同じ陸海マスクなので欠測は欠測のまま伝播)
sst_ann = sst.mean(axis=0)  # masked array の mean はマスクを保持
save_json("sst_ann", "degC", SST_SRC + " (年平均は12ヶ月気候値の単純平均)", regrid(sst_ann, lat, lon))
ds.close()

# ---------------------------------------------------------------------------
# 海氷密接度 (NOAA OISST V2 付属, 1x1 度格子, 360x180)
ICEC_SRC = ("NOAA PSL, NOAA Optimum Interpolation SST V2 付属海氷密接度, icec.ltm.nc "
            "(https://downloads.psl.noaa.gov/Datasets/noaa.oisst.v2/icec.ltm.nc), "
            "元格子 1x1 度 (360x180), 気候値期間 1991-2020, 公有データ")
ds, lat, lon, icec = open_var("icec.ltm.nc", "icec")
save_json("icec_jan", "%", ICEC_SRC, regrid(icec[0], lat, lon))
save_json("icec_jul", "%", ICEC_SRC, regrid(icec[6], lat, lon))
ds.close()

print("完了")
