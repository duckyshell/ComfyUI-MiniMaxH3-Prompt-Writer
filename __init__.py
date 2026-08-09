from pathlib import Path

import folder_paths

from .backend.version import VERSION


WEB_DIRECTORY = "./web"

LLM_MODELS_DIRECTORY = Path(folder_paths.models_dir) / "LLM"
LLM_MODELS_DIRECTORY.mkdir(parents=True, exist_ok=True)
folder_paths.add_model_folder_path("LLM", str(LLM_MODELS_DIRECTORY), is_default=True)

# Importing the route module registers the extension endpoints with ComfyUI.
from .backend import routes as _routes  # noqa: E402,F401

NODE_CLASS_MAPPINGS = {}
NODE_DISPLAY_NAME_MAPPINGS = {}

__version__ = VERSION

__all__ = ["NODE_CLASS_MAPPINGS", "NODE_DISPLAY_NAME_MAPPINGS", "WEB_DIRECTORY", "__version__"]
