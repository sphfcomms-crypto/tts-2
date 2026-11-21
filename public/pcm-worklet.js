// Turns microphone audio into 100 ms blocks of mono PCM16 and posts them to
// the page. The AudioContext runs at 24 kHz, the rate the Realtime
// transcription API expects, so no resampling is needed here.
class PcmCapture extends AudioWorkletProcessor {
  constructor() {
    super();
    this.block = new Int16Array(2400);
    this.filled = 0;
  }

  process(inputs) {
    const channel = inputs[0] && inputs[0][0];
    if (!channel) return true;

    for (let i = 0; i < channel.length; i++) {
      const sample = Math.max(-1, Math.min(1, channel[i]));
      this.block[this.filled++] = sample < 0 ? sample * 0x8000 : sample * 0x7fff;

      if (this.filled === this.block.length) {
        this.port.postMessage(this.block.buffer, [this.block.buffer]);
        this.block = new Int16Array(2400);
        this.filled = 0;
      }
    }
    return true;
  }
}

registerProcessor("pcm-capture", PcmCapture);
