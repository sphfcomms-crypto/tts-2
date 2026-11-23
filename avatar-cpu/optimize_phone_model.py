"""Build the CPU phoneme graph from the pinned Wav2Vec2 INT8 export.

Install the build dependency with `python -m pip install onnx==1.18.0`.
Usage: python optimize_phone_model.py model_int8.onnx /opt/tts/performance-data/models/phoneme-int8.onnx

Source: onnx-community/wav2vec2-lv-60-espeak-cv-ft-ONNX at
c69750f5043e5e1f8a71ab95dd3b98338c280c92, onnx/model_int8.onnx.
"""

import argparse
import hashlib
import os
from pathlib import Path
import tempfile

import numpy as np
import onnx
from onnx import helper, numpy_helper

SOURCE_SHA256 = "74174710e34035bbb7f611601d016c32fc575de7a6f53b1078107dc10a84e7ae"
OPTIMIZED_SHA256 = "f9951049b234bdb892406c9a6ab96d49d1d93e3bc5e2ea7bc2c4338478c52d7b"


def digest(path):
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def replace_convolution(graph, node, weight):
    """Use the CPU's integer matrix multiply for this 1-D convolution.

    Each row of the input matrix contains one sliding window. Each column of
    the weight matrix contains one original output filter. The input and weight
    zero points remain unchanged, including at the padded ends of a recording.
    """
    attributes = {item.name: helper.get_attribute_value(item) for item in node.attribute}
    kernel, = attributes["kernel_shape"]
    stride, = attributes["strides"]
    groups = attributes["group"]
    x, _, input_zero, weight_zero = node.input
    output_channels, input_channels_per_group, filter_width = weight.shape
    if filter_width != kernel or attributes["dilations"] != [1] or weight.dtype != np.int8:
        raise ValueError(f"Unsupported source convolution {node.name}")

    base = node.name + "/gemm/"
    replacements = []

    def constant(tag, value, dtype=np.int64):
        name = base + tag
        graph.initializer.append(numpy_helper.from_array(np.asarray(value, dtype=dtype), name=name))
        return name

    def op(kind, tag, inputs, **attrs):
        name = base + tag
        replacements.append(helper.make_node(kind, inputs, [name], name=name, **attrs))
        return name

    width = kernel * input_channels_per_group
    if groups == 1:
        filters = weight.transpose(2, 1, 0).reshape(width, output_channels)
    else:
        filters = weight.reshape(groups, output_channels // groups, input_channels_per_group, kernel)
        filters = filters.transpose(0, 3, 2, 1).reshape(groups, width, output_channels // groups)
    matrix_weight = constant("weight", filters, np.int8)

    left, right = attributes["pads"]
    if left or right:
        padding = constant("pad", [0, 0, left, 0, 0, right])
        x = op("Pad", "padded", [x, padding, input_zero], mode="constant")
    shape = op("Shape", "shape", [x])
    length = op("Gather", "length", [shape, constant("two", 2)], axis=0)
    limit = op("Sub", "limit", [length, constant("k_minus_one", kernel - 1)])
    starts = op("Range", "starts", [constant("zero", 0), limit, constant("stride", stride)])
    starts = op("Unsqueeze", "expand", [starts, constant("axis", [1])])
    indices = op("Add", "indices", [starts, constant("offsets", range(kernel))])
    channels_last = op("Transpose", "channels_last", [x], perm=[0, 2, 1])
    patches = op("Gather", "windows", [channels_last, indices], axis=1)

    if groups == 1:
        matrix = op("Reshape", "matrix", [patches, constant("matrix_shape", [0, 0, width])])
        product = op("MatMulInteger", "product", [matrix, matrix_weight, input_zero, weight_zero])
        last = helper.make_node("Transpose", [product], node.output, name=base + "channels_first",
                                perm=[0, 2, 1])
    else:
        # The positional convolution has sixteen independent banks of filters.
        group_shape = constant("group_shape", [0, 0, kernel, groups, input_channels_per_group])
        split = op("Reshape", "groups", [patches, group_shape])
        split = op("Transpose", "group_first", [split], perm=[0, 3, 1, 2, 4])
        matrix = op("Reshape", "matrix", [split, constant("matrix_shape", [0, 0, 0, width])])
        product = op("MatMulInteger", "product", [matrix, matrix_weight, input_zero, weight_zero])
        product = op("Transpose", "channels_first", [product], perm=[0, 1, 3, 2])
        output_shape = constant("output_shape", [0, output_channels, -1])
        last = helper.make_node("Reshape", [product, output_shape], node.output, name=base + "output")
    replacements.append(last)
    return replacements


def optimize(source, destination):
    if onnx.__version__ != "1.18.0":
        raise ValueError("The reproducible build uses onnx==1.18.0")
    if source.resolve() == destination.resolve():
        raise ValueError("Supply separate input and output paths")
    if digest(source) != SOURCE_SHA256:
        raise ValueError("Input SHA-256 differs from the pinned Wav2Vec2 INT8 export")
    if destination.is_file() and digest(destination) == OPTIMIZED_SHA256:
        return

    model = onnx.load(source)
    graph = model.graph
    initializers = {value.name: value for value in graph.initializer}
    nodes = []
    replaced = set()
    for node in graph.node:
        if node.op_type == "ConvInteger":
            name = node.input[1]
            nodes.extend(replace_convolution(graph, node, numpy_helper.to_array(initializers[name])))
            replaced.add(name)
        else:
            nodes.append(node)
    if len(replaced) != 8:
        raise ValueError("Expected eight distinct convolution weights in the pinned graph")
    for i in reversed(range(len(graph.initializer))):
        if graph.initializer[i].name in replaced:
            del graph.initializer[i]
    del graph.node[:]
    graph.node.extend(nodes)

    destination.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile(dir=destination.parent, prefix=".phoneme-", delete=False) as file:
        temporary = Path(file.name)
    try:
        onnx.save(model, temporary)
        if digest(temporary) != OPTIMIZED_SHA256:
            raise ValueError("Optimized graph differs from the verified artifact")
        # A root-run install must leave the public model readable by tts-avatar.
        temporary.chmod(0o644)
        os.replace(temporary, destination)
    finally:
        temporary.unlink(missing_ok=True)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("source", type=Path)
    parser.add_argument("output", type=Path)
    args = parser.parse_args()
    optimize(args.source, args.output)
    print(f"{OPTIMIZED_SHA256}  {args.output}")
