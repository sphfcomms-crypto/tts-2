# CPU acoustic model

The service reads `uni2005-int8.onnx` from its configured model directory. The graph includes the 229 IPA symbols and CTC blank. Inference runs on the CPU using ONNX Runtime. Runtime startup never downloads model weights.

The source is Xinjian Li and colleagues’ *Universal Phone Recognition with a Multilingual Allophone System*. The conversion uses their uni2005 checkpoint from the [upstream Allosaurus v1.0 release](https://github.com/xinjli/allosaurus/releases/tag/v1.0). The [upstream repository](https://github.com/xinjli/allosaurus) carries GPL-3.0. The authors’ model archive contains no separate model-license file. This repository includes the conversion and runtime code. Weights are provisioned separately.

## Provisioning

Run the exporter once in a separate Python 3.12 environment with CPU PyTorch 2.7.1, ONNX 1.18.0, ONNX Runtime 1.22.1 and ml-dtypes 0.5.1. The deployed reference conversion used NumPy 2.5.5 and protobuf 7.36.2. The CPU service itself uses the versions in `requirements.txt`. To convert from the verified upstream download or an existing archive:

```sh
python build_phone_model.py /opt/tts/performance-data/models
# Or use an already-downloaded source archive.
python build_phone_model.py /opt/tts/performance-data/models --archive /path/to/uni2005.tar.gz
```

The verified source archive SHA-256 is `7dc4f20802012f64ac07deb04ade263f199c839521e58eae83c99d79028fc4de`. The reference converted ONNX graph SHA-256 is `9f8fb2352220186cf90e2a98b15f95f189a94290b0983d5d558814830c4d661f`. A failed conversion leaves a previously installed graph intact.

## Acoustic timing

`PhoneModel.weights(pcm16k, lead_samples, n_frames)` accepts mono normalized PCM and returns convex weights over `PHONES` at 25 fps. Output begins at `lead_samples` in the supplied waveform. Real caller requests carry up to 200 ms of previous audio and 100 ms of following audio. The classifier uses 8 kHz MFCC windows. Three 10 ms phases of its trained 30 ms recurrent stride improve short consonant sampling. A coarticulation window keeps the jaw moving between CTC phone peaks. Strong labial releases select an anticipatory seal. Silent source frames use REST.

Run `python -m unittest test_phones` from this directory for the cue, timing, terminal audio and silence checks.
