# CPU acoustic model

The CPU service uses Wav2Vec2 to identify spoken phones at 20 ms intervals, including the quiet frication in *saaf*. A smaller uni2005 model handles requests when the larger model is missing, busy or temporarily unavailable. Both use local files in the configured model directory.

## Wav2Vec2

The Apache-2.0 checkpoint is Facebook's 24-layer multilingual Wav2Vec2 LV-60 eSpeak CTC model. The pinned ONNX Community conversion includes an INT8 model and its 392-symbol vocabulary. [Model and license](https://huggingface.co/onnx-community/wav2vec2-lv-60-espeak-cv-ft-ONNX/tree/c69750f5043e5e1f8a71ab95dd3b98338c280c92)

Use a separate build environment with `onnx==1.18.0` and NumPy. The optimizer expresses the eight 1D convolutions as integer windowed matrix products while preserving the trained weights, layers, strides and CTC output. The raw INT8 graph also works with the pinned service runtime.

```sh
model_dir=/opt/tts/performance-data/models
source_url=https://huggingface.co/onnx-community/wav2vec2-lv-60-espeak-cv-ft-ONNX/resolve/c69750f5043e5e1f8a71ab95dd3b98338c280c92
mkdir -p "$model_dir"
curl -fL "$source_url/onnx/model_int8.onnx" -o /tmp/wav2vec2-espeak-int8.onnx
curl -fL "$source_url/vocab.json" -o /tmp/wav2vec2-espeak-vocab.json
echo '74174710e34035bbb7f611601d016c32fc575de7a6f53b1078107dc10a84e7ae  /tmp/wav2vec2-espeak-int8.onnx' | sha256sum -c -
echo 'd732ab2456c0c017930001dc9af0b41b3b93d25b2eb9740bf9d925508d7d87d0  /tmp/wav2vec2-espeak-vocab.json' | sha256sum -c -
python optimize_phone_model.py /tmp/wav2vec2-espeak-int8.onnx "$model_dir/phoneme-int8.onnx"
install -m 0644 /tmp/wav2vec2-espeak-vocab.json "$model_dir/phoneme-vocab.json"
```

Restart the service after both files are installed. A fully silent render interval skips both classifiers. Voiced requests prefer Wav2Vec2, with up to two simultaneous inferences per process. A third request uses uni2005 immediately. An inference failure also falls back and triggers a 15-second cooldown before the next attempt.

## Compact model

The source is Xinjian Li and colleagues’ *Universal Phone Recognition with a Multilingual Allophone System*. The conversion uses their uni2005 checkpoint from the [upstream Allosaurus v1.0 release](https://github.com/xinjli/allosaurus/releases/tag/v1.0). The [upstream repository](https://github.com/xinjli/allosaurus) carries GPL-3.0. The authors’ model archive contains no separate model-license file. This repository includes the conversion and runtime code. Weights are provisioned separately.

Run the exporter once in a separate Python 3.12 environment with CPU PyTorch 2.7.1, ONNX 1.18.0, ONNX Runtime 1.22.1 and ml-dtypes 0.5.1. The deployed reference conversion used NumPy 2.5.5 and protobuf 7.36.2. The CPU service uses the versions in `requirements.txt`.

```sh
python build_phone_model.py /opt/tts/performance-data/models
# Or use an already-downloaded source archive.
python build_phone_model.py /opt/tts/performance-data/models --archive /path/to/uni2005.tar.gz
```

The verified source archive SHA-256 is `7dc4f20802012f64ac07deb04ade263f199c839521e58eae83c99d79028fc4de`. The reference converted ONNX graph SHA-256 is `9f8fb2352220186cf90e2a98b15f95f189a94290b0983d5d558814830c4d661f`. A failed conversion leaves a previously installed graph intact.

## Acoustic timing

`PhoneModel.weights(pcm16k, lead_samples, n_frames)` accepts mono normalized PCM and returns convex weights over `PHONES` at 25 fps. Output begins at `lead_samples` in the supplied waveform. Real caller requests carry up to 200 ms of previous audio and 100 ms of following audio. Wav2Vec2 uses the original 16 kHz waveform. The compact model uses 8 kHz MFCC windows and three 10 ms phases of its trained 30 ms stride. A coarticulation window carries the vowel pose through internal tongue movements. Bilabial seals anticipate the sound and labiodental contacts coincide with frication. Silent source frames use REST.

Run `python -m unittest test_phones` from this directory for the cue, timing, terminal audio and silence checks.
