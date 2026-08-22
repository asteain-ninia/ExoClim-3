# -*- coding: utf-8 -*-
"""10m 風(NCEP/NCAR R1 ltm)を 12 か月ぶん共通 2 度格子 JSON へ(目的関数 v7 の陸上風速項用)。
convert_obs.py と同じ格子・同じ最近傍リグリッド。"""
import json, os
import numpy as np
import netCDF4 as nc
H, W, RES, LON0 = 90, 180, 2.0, -180.0
tlat = 90.0 - (np.arange(H) + 0.5) * RES
tlon = LON0 + (np.arange(W) + 0.5) * RES
tlon360 = np.where(tlon < 0, tlon + 360.0, tlon)
def nearest(src, tgt):
    return np.argmin(np.abs(np.asarray(src)[None, :] - np.asarray(tgt)[:, None]), axis=1)
def regrid(a, lat, lon):
    li, lo = nearest(lat, tlat), nearest(lon, tlon360)
    out = np.asarray(a)[li][:, lo]
    m = np.ma.getmaskarray(a)[li][:, lo] if np.ma.isMaskedArray(a) else np.zeros_like(out, bool)
    out = np.where(m, -9999.0, out)
    return out
here = os.path.dirname(os.path.abspath(__file__))
for var, fn in (("uwnd", "uwnd.10m.mon.ltm.nc"), ("vwnd", "vwnd.10m.mon.ltm.nc")):
    ds = nc.Dataset(os.path.join(here, fn))
    lat, lon, v = ds["lat"][:], ds["lon"][:], ds[var][:]
    for m in range(12):
        g = regrid(v[m], lat, lon)
        json.dump({"width": W, "height": H, "missing": -9999.0, "units": "m/s",
                   "source": f"NOAA PSL NCEP/NCAR R1 {fn} 1991-2020 ltm, month {m+1}",
                   "values": [float(x) for x in g.ravel()]},
                  open(os.path.join(here, f"{var}10_m{m+1:02d}.json"), "w"))
    print(var, "12 か月 ok")
