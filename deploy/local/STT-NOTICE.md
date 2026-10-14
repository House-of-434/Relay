# STT model attribution

This image bundles the **Parakeet TDT 0.6B v2 (int8)** speech-to-text model,
redistributed by the [sherpa-onnx](https://github.com/k2-fsa/sherpa-onnx)
project (Apache-2.0 tooling) from NVIDIA's NeMo checkpoints.

- Model: `nvidia/parakeet-tdt-0.6b-v2`
- License: **CC-BY-4.0** — commercial use permitted, attribution required.
- Retrieved from:
  `https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-nemo-parakeet-tdt-0.6b-v2-int8.tar.bz2`

Attribution: "Parakeet TDT 0.6B v2" by NVIDIA Corporation, licensed under
CC-BY-4.0. Converted to ONNX and distributed by the sherpa-onnx project.

The STT server code (`parakeet_server.py`) is part of Relay and uses only the
public `sherpa-onnx` Python API.
