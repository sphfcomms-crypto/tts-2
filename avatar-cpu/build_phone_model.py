"""Convert the pinned uni2005 model once, outside the serving process."""
import argparse
import hashlib
import io
import json
import os
from pathlib import Path
import shutil
import tarfile
import tempfile
from urllib.request import urlopen

import numpy as np
import onnx
from onnx import TensorProto, helper, numpy_helper
from onnxruntime.quantization import QuantType, quantize_dynamic
import torch

URL = "https://github.com/xinjli/allosaurus/releases/download/v1.0/uni2005.tar.gz"
ARCHIVE_SHA = "7dc4f20802012f64ac07deb04ade263f199c839521e58eae83c99d79028fc4de"
MODEL_FILE = "uni2005-int8.onnx"


def make_graph(state, labels):
    """ONNX LSTM gate order is input, output, forget, cell (PyTorch is i,f,c,o)."""
    nodes, initializers = [], []

    def tensor(name, value):
        initializers.append(numpy_helper.from_array(np.ascontiguousarray(value), name))
        return name

    shape = tensor("sequence_shape", np.array([-1, 1, 640], dtype=np.int64))
    features = "mfcc"
    for layer in range(5):
        weights = []
        for part in ("weight_ih", "weight_hh", "bias_ih", "bias_hh"):
            pair = []
            for direction in ("", "_reverse"):
                param = state[f"blstm_layer.{part}_l{layer}{direction}"].numpy()
                gates = np.split(param, 4)
                pair.append(np.concatenate([gates[i] for i in (0, 3, 1, 2)]))
            weights.append(np.stack(pair))
        w = tensor(f"W{layer}", weights[0])
        r = tensor(f"R{layer}", weights[1])
        b = tensor(f"B{layer}", np.concatenate(weights[2:], axis=1))
        y, xt = f"y{layer}", f"x{layer}"
        nodes.append(helper.make_node("LSTM", [features, w, r, b], [y],
                                      direction="bidirectional", hidden_size=320, name=f"layer{layer}"))
        # Batch is always one. Flatten both directional outputs per audio timestep.
        nodes.append(helper.make_node("Reshape", [y, shape], [xt]))
        features = xt
    w = tensor("projection", state["phone_layer.weight"].numpy().T)
    b = tensor("bias", state["phone_layer.bias"].numpy())
    nodes.append(helper.make_node("MatMul", [features, w], ["projection_out"]))
    nodes.append(helper.make_node("Add", ["projection_out", b], ["logits"]))
    graph = helper.make_graph(nodes, "uni2005",
        [helper.make_tensor_value_info("mfcc", TensorProto.FLOAT, ["time", 1, 120])],
        [helper.make_tensor_value_info("logits", TensorProto.FLOAT, ["time", 1, len(labels)])],
        initializers)
    model = helper.make_model(graph, opset_imports=[helper.make_opsetid("", 17)],
                              producer_name="tts-urdu", ir_version=8)
    helper.set_model_props(model, {"ipa": json.dumps(labels, ensure_ascii=False),
                                   "source_sha256": ARCHIVE_SHA})
    onnx.checker.check_model(model)
    return model


def build(destination, archive=None):
    destination.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(dir=destination) as tmp:
        tmp = Path(tmp)
        if archive is None:
            archive = tmp / "uni2005.tar.gz"
            with urlopen(URL, timeout=90) as src, archive.open("wb") as out:
                shutil.copyfileobj(src, out)
        with archive.open("rb") as f:
            if hashlib.file_digest(f, "sha256").hexdigest() != ARCHIVE_SHA:
                raise ValueError("unexpected Allosaurus uni2005 archive checksum")
        with tarfile.open(archive) as tar:
            state = torch.load(io.BytesIO(tar.extractfile("uni2005/model.pt").read()),
                               map_location="cpu", weights_only=True)
            labels = ["<blank>"] * 230
            for line in tar.extractfile("uni2005/phone.txt").read().decode().splitlines():
                symbol, index = line.rsplit(maxsplit=1)
                labels[int(index)] = symbol.strip()
        float_model = tmp / "uni2005.onnx"
        onnx.save_model(make_graph(state, labels), float_model)
        output = tmp / MODEL_FILE
        quantize_dynamic(float_model, output, weight_type=QuantType.QInt8,
                         op_types_to_quantize=["LSTM", "MatMul"], per_channel=True)
        os.replace(output, destination / MODEL_FILE)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("destination", type=Path)
    parser.add_argument("--archive", type=Path, help="use an already downloaded, verified archive")
    args = parser.parse_args()
    build(args.destination, args.archive)
