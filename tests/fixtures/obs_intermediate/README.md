# 中間場の観測(目的関数 v7「中間場の係留」の教師データ)

出所: NOAA Physical Sciences Laboratory(downloads.psl.noaa.gov)。**公有(public domain)**。
気候値期間: 1991-2020 の月別長期平均(ltm)。各 .nc の `climo_period` 属性で確認。

| ファイル | 中身 | 原データ |
| --- | --- | --- |
| sst.ltm.nc / sst_ann.json | 海面水温(年平均) | NOAA OI SST V2 |
| uwnd.10m / vwnd.10m .mon.ltm.nc、uwnd10_mNN / vwnd10_mNN .json | 10m 風の月別(12 か月) | NCEP/NCAR Reanalysis 1 |
| slp.mon.ltm.nc、slp_jan/jul.json | 海面気圧 | NCEP/NCAR Reanalysis 1 |
| icec.ltm.nc、icec_jan/jul.json | 海氷密接度 | NOAA OI SST V2 |
| pr_wtr.eatm.mon.ltm.nc、prwtr_mNN.json | 可降水量の月別(12 か月、mm) | NCEP/NCAR Reanalysis 1(変換は convert_prwtr.py。極域にごく小さな負値があり得る — 採点側で 0 に切り上げる) |
| precip.mon.ltm.nc、precip_ocean_mNN.json | 海上降水 | (別途収蔵: 変換は convert_precip.py) |

共通格子: 2°(90×180)、行 0 = 北端(中心 89°N)、列 0 = 西端(中心 −179°)。
欠測 = −9999。変換: `convert_obs.py`(1・7 月版)/ `convert_wind_months.py`(風 12 か月)。

収蔵の経緯: 2026-08-21 に副スレッド(計算順デバッグ報告)が一時領域へ取得したものを、
目的関数 v7 の材料として 2026-08-22 にリポへ収蔵。
