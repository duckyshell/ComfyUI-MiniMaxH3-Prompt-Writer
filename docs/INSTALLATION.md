# Installation

## Get the extension

With Git, open a terminal in `ComfyUI/custom_nodes`, copy the repository URL from
GitHub's **Code** menu, and run:

```powershell
git clone https://github.com/duckyshell/ComfyUI-MiniMaxH3-Prompt-Writer.git
```

Without Git, choose **Code > Download ZIP** on GitHub. Extract the archive into
`ComfyUI/custom_nodes` and rename the extracted folder to
`ComfyUI-MiniMaxH3-Prompt-Writer` if needed.

Whichever method you use, the final path must be:

```text
ComfyUI/custom_nodes/ComfyUI-MiniMaxH3-Prompt-Writer/
```

## Windows Portable ComfyUI

The full Portable layout should look like this:

```text
ComfyUI_Portable/
└── ComfyUI/
    └── custom_nodes/
        └── ComfyUI-MiniMaxH3-Prompt-Writer/
```

From the Portable root, use the embedded Python rather than the system Python:

```powershell
python_embeded\python.exe -m pip install -r ComfyUI\custom_nodes\ComfyUI-MiniMaxH3-Prompt-Writer\requirements.txt
```

The base extension has no additional Python packages. Local GGUF generation needs
`llama-cpp-python`:

```powershell
python_embeded\python.exe -m pip install --only-binary=:all: `
  --extra-index-url https://abetlen.github.io/llama-cpp-python/whl/cu130 `
  -r ComfyUI\custom_nodes\ComfyUI-MiniMaxH3-Prompt-Writer\requirements-gguf.txt
```

This CUDA 13.0 command was tested for the v0.2.0 release with
`llama-cpp-python` 0.3.34. The requirement accepts 0.3.x releases starting at
0.3.34, so it does not force a working newer 0.3.x installation to
downgrade. For another CUDA/Python combination, use a compatible pre-built wheel
published by
[`llama-cpp-python`](https://github.com/abetlen/llama-cpp-python). Keep
`--only-binary=:all:` so a missing wheel fails clearly instead of starting a long
local C++ build.

Restart ComfyUI, then click the floating **H3 Prompt Writer** button. If the button
is not visible, open **Extensions > H3 Prompt Writer** from the ComfyUI menu.

## Models

Download one model GGUF and the matching `mmproj` listed in
[MODELS.md](MODELS.md). Put both files in the same folder:

```text
ComfyUI/models/LLM/
├── gemma-4-...gguf
└── mmproj-BF16.gguf
```

Subfolders are supported. Use each model listed in [MODELS.md](MODELS.md) with
the projector linked in the same table. Do not share one projector between
different Gemma model classes merely because the filename is identical.

Open H3 Prompt Writer and press **Refresh** in the model menu after adding files.
If no model is present, it shows exact verified Hugging Face pages for each model/projector
pair. It marks which tier fits the detected total VRAM for ComfyUI's active CUDA
device; this is a capacity hint, not a quality recommendation, and selection remains manual.

## Standard Python environments

Windows Portable with CUDA 13.0 is the setup tested for the v0.2.0 release. Other
ComfyUI Python environments may work, but they were not part of that release
test.

Install both requirement files using the Python interpreter that launches ComfyUI:

```bash
python -m pip install -r requirements.txt
python -m pip install -r requirements-gguf.txt
```

GPU acceleration depends on how `llama-cpp-python` was built. A CPU-only wheel can
load successfully but will not provide the intended performance.

## Verify the installation

After ComfyUI starts:

1. Confirm the floating **H3 Prompt Writer** launcher is visible.
2. Open H3 Prompt Writer and check the local model row.
3. If no model is installed, confirm the setup list and model path are visible.
4. After adding a complete model/projector pair, press **Refresh** and confirm the
   model reports `GGUF` without a missing-dependency message.

See [Troubleshooting](TROUBLESHOOTING.md) if the extension or model is not ready.
