import netCDF4 as nc
import sys

files = [
    "slp.mon.ltm.nc",
    "uwnd.10m.mon.ltm.nc",
    "vwnd.10m.mon.ltm.nc",
    "sst.ltm.nc",
    "icec.ltm.nc",
]

for fname in files:
    print("=" * 60)
    print(fname)
    ds = nc.Dataset(fname)
    print("dims:", {k: len(v) for k, v in ds.dimensions.items()})
    print("vars:", list(ds.variables.keys()))
    for vname in ds.variables:
        v = ds.variables[vname]
        print(f"  {vname}: shape={v.shape} dims={v.dimensions}")
        attrs = {a: getattr(v, a) for a in v.ncattrs()}
        print(f"    attrs={attrs}")
    ds.close()
