import netCDF4 as nc

ds = nc.Dataset("precip.mon.ltm.nc")
print("dims:", {k: len(v) for k, v in ds.dimensions.items()})
print("vars:", list(ds.variables.keys()))
for vname in ds.variables:
    v = ds.variables[vname]
    print(f"  {vname}: shape={v.shape} dims={v.dimensions}")
    attrs = {a: getattr(v, a) for a in v.ncattrs()}
    print(f"    attrs={attrs}")
ds.close()
