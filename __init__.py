import logging

from .nodes import NODE_CLASS_MAPPINGS, NODE_DISPLAY_NAME_MAPPINGS

WEB_DIRECTORY = "./web"

__all__ = ["NODE_CLASS_MAPPINGS", "NODE_DISPLAY_NAME_MAPPINGS", "WEB_DIRECTORY"]

EXTENSION_ROUTE_PREFIX = "/extensions/ComfyUI-OutpaintMask"


def _install_no_cache_middleware():
    """
    Adds a no-cache header to every frontend JS response of this node pack so
    the browser / ComfyUI Desktop (Electron) never caches an old copy.
    The server reads the file straight from the repo, so every edit takes
    effect after a simple page reload.
    """
    try:
        from aiohttp import web
        from server import PromptServer

        @web.middleware
        async def _no_cache_outpaint(request, handler):
            response = await handler(request)
            try:
                if request.path.startswith(EXTENSION_ROUTE_PREFIX):
                    response.headers["Cache-Control"] = "no-store, must-revalidate"
            except Exception:
                pass
            return response

        app = PromptServer.instance.app
        # Module reloads create a new function object, so identity checks
        # would duplicate the middleware on every "Refresh Custom Nodes".
        # Guard by name instead.
        for mw in app.middlewares:
            if getattr(mw, "__name__", "") == "_no_cache_outpaint":
                return
        app.middlewares.append(_no_cache_outpaint)
        logging.info("[OutpaintMask] no-cache middleware installed for /extensions/ComfyUI-OutpaintMask")
    except Exception as e:
        logging.warning("[OutpaintMask] failed to install no-cache middleware: %s", e)


_install_no_cache_middleware()
