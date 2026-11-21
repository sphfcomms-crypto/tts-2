import bpy, addon_utils, traceback
print("MODS", [m.__name__ for m in addon_utils.modules() if 'mpfb' in m.__name__])
try:
    import bl_ext.user_default.mpfb as mpfb
    print("VER", getattr(mpfb,'VERSION',None), getattr(mpfb,'BUILD_INFO',None))
    from bl_ext.user_default.mpfb.services.locationservice import LocationService
    print("USERDATA", LocationService.get_user_data())
    print("USERHOME", LocationService.get_user_home())
except Exception as e:
    traceback.print_exc()
