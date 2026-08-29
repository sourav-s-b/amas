class PCMProcessor extends AudioWorkletProcessor {
    constructor() {
        super();
        this.bufferSize = 4096;
        this.buffer = new Float32Array(this.bufferSize);
        this.bufferIndex = 0;
        this.callCount = 0;
    }

    process(inputs) {
        const input = inputs[0];
        this.callCount++;

        // Log every 20th call so we can see if process() keeps running
        if (this.callCount % 20 === 0) {
            const channelData = input?.[0];
            const hasSignal = channelData ? channelData.some(v => v !== 0) : false;
            console.log(`[call ${this.callCount}] channels: ${input?.length}, samples: ${channelData?.length}, hasSignal: ${hasSignal}`);
        }

        if (input && input.length > 0) {
            const channelData = input[0];
            for (let i = 0; i < channelData.length; i++) {
                this.buffer[this.bufferIndex++] = channelData[i];
                if (this.bufferIndex >= this.bufferSize) {
                    this.port.postMessage(this.buffer.slice());
                    this.bufferIndex = 0;
                }
            }
        }
        return true;
    }
}
registerProcessor('pcm-processor', PCMProcessor);
