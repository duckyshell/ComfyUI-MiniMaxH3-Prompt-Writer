"""The small part of ComfyUI's server module used by Prompt Writer."""

from aiohttp import web


class PromptServer:
    instance: "PromptServer | None" = None

    def __init__(self) -> None:
        self.routes = web.RouteTableDef()


PromptServer.instance = PromptServer()
