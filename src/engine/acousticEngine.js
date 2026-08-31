// @ts-check
import ggwaveFactory from "@vpalmisano/ggwave";

/**
 * @typedef {Object} AcousticTransceiverOptions
 * @property {number} [payloadLength=32]      Fixed payload length (must match sender/receiver)
 * @property {number} [freqStart=390]         MT_FASTEST start frequency bin (~18.3-19.8kHz)
 * @property {number} [volume=10]             Send volume (0-100 as used by ggwave)
 * @property {string} [workletUrl="/audio-worklet-processor.js"]  Path to the AudioWorklet module
 * @property {(rms: number) => void} [onLevel]        Called on every mic frame with current RMS
 * @property {(message: string) => void} [onMessage]  Called when a payload is successfully decoded
 * @property {(message: string) => void} [onLog]      Called for human-readable status updates
 * @property {(error: Error) => void} [onError]       Called on recoverable errors
 */


export class AcousticTransceiver {
    /** @param {AcousticTransceiverOptions} [options] */
    constructor(options = {}) {
        this.options = {
            payloadLength: 32,
            freqStart: 390,
            volume: 10,
            workletUrl: "/audio-worklet-processor.js",
            onLevel: () => {},
            onMessage: () => {},
            onLog: () => {},
            onError: () => {},
            ...options,
        };

        /** @type {any} ggwave WASM module instance */
        this.gg = null;
        this.playbackCtx = null;

        this.mediaStream = null;
        this.pipelineCtx = null;
        this.pipelineNode = null;
        this.pipelineSource = null;
        this.pipelineReady = false;

        this.isListening = false;
        this.rxInstance = null; // ggwave instance handle (can legitimately be 0)

        this._ready = null; // init() promise, memoized
    }

    /** Update runtime-tunable options (payloadLength, freqStart, volume, callbacks, etc). */
    configure(partialOptions) {
        Object.assign(this.options, partialOptions);
        if (this.gg && partialOptions.freqStart !== undefined) {
            this._applyFreqStart();
        }
    }

    /** Load the ggwave WASM module. Safe to call multiple times — memoized. */
    async init() {
        if (this._ready) return this._ready;
        this._ready = (async () => {
            try {
                this.gg = await ggwaveFactory();
                this._applyFreqStart();
                this.options.onLog("ggwave initialized successfully!");
            } catch (err) {
                this.options.onError(err);
                throw err;
            }
        })();
        return this._ready;
    }

    _applyFreqStart() {
        const id = this._getMtFastestProtocolId();
        if (id == null) {
            this.options.onLog(
                "MT_FASTEST protocol not found on this ggwave build.",
            );
            return;
        }
        this.gg.txProtocolSetFreqStart?.(id, this.options.freqStart);
        this.gg.rxProtocolSetFreqStart?.(id, this.options.freqStart);
    }

    _getMtFastestProtocolId() {
        const unified = this.gg.ProtocolId;
        const legacy = this.gg.TxProtocolId;
        return (
            unified?.GGWAVE_PROTOCOL_MT_FASTEST ??
            legacy?.GGWAVE_TX_PROTOCOL_MT_FASTEST ??
            legacy?.GGWAVE_PROTOCOL_MT_FASTEST ??
            null
        );
    }

    _getProtocolId() {
        return this._getMtFastestProtocolId() ?? 1;
    }

    /** Get (and cache) a mic MediaStream. Reused across start/stop so the OS/driver mic stays warm. */
    async _getMicStream() {
        if (this.mediaStream && this.mediaStream.active) return this.mediaStream;
        this.mediaStream = await navigator.mediaDevices.getUserMedia({
            audio: {
                echoCancellation: false,
                noiseSuppression: false,
                autoGainControl: false,
            },
            video: false,
        });
        return this.mediaStream;
    }

    /** Build the persistent AudioContext + worklet graph once. Reused for every listen session. */
    async _ensurePipeline() {
        if (this.pipelineReady) return;
        await this.init();

        this.pipelineCtx = new (window.AudioContext || window.webkitAudioContext)();
        await this.pipelineCtx.audioWorklet.addModule(this.options.workletUrl);

        const stream = await this._getMicStream();
        this.pipelineSource = this.pipelineCtx.createMediaStreamSource(stream);
        this.pipelineNode = new AudioWorkletNode(this.pipelineCtx, "pcm-processor");
        this.pipelineSource.connect(this.pipelineNode);
        this.pipelineNode.connect(this.pipelineCtx.destination);

        this.pipelineReady = true;
    }

    /** Pre-build the mic/worklet pipeline ahead of time (e.g. on mount) so the first listen has no setup delay. */
    async warmUp() {
        try {
            await this._ensurePipeline();
            this.options.onLog("Pipeline pre-warmed.");
        } catch (err) {
            this.options.onError(err);
        }
    }

    /** Encode and play `payload` through the speakers. */
    async send(payload) {
        await this.init();

        if (!this.playbackCtx) {
            this.playbackCtx = new (window.AudioContext || window.webkitAudioContext)();
        }

        const parameters = this.gg.getDefaultParameters();
        parameters.sampleRateInp = this.playbackCtx.sampleRate;
        parameters.sampleRateOut = this.playbackCtx.sampleRate;
        parameters.payloadLength = this.options.payloadLength;

        const instance = this.gg.init(parameters);
        try {
            const waveform = this.gg.encode(
                instance,
                payload,
                this._getProtocolId(),
                this.options.volume,
            );
            if (!waveform) {
                throw new Error("Failed to encode payload.");
            }

            const floatSamples = new Float32Array(
                waveform.buffer,
                waveform.byteOffset,
                waveform.byteLength / 4,
            );
            const audioBuffer = this.playbackCtx.createBuffer(
                1,
                floatSamples.length,
                this.playbackCtx.sampleRate,
            );
            audioBuffer.getChannelData(0).set(floatSamples);

            const source = this.playbackCtx.createBufferSource();
            source.buffer = audioBuffer;
            source.connect(this.playbackCtx.destination);
            source.start(0);

            this.options.onLog(`Playing "${payload}" through speakers.`);
        } finally {
            this.gg.free(instance);
        }
    }

    /** Start capturing mic audio and attempting to decode incoming payloads. */
    async startListening() {
        if (this.isListening) return;

        await this._ensurePipeline();
        if (this.pipelineCtx.state === "suspended") {
            await this.pipelineCtx.resume();
        }

        const parameters = this.gg.getDefaultParameters();
        parameters.sampleRateInp = this.pipelineCtx.sampleRate;
        parameters.sampleRateOut = this.pipelineCtx.sampleRate;
        parameters.payloadLength = this.options.payloadLength;
        
        this.rxInstance = this.gg.init(parameters);

        this.pipelineNode.port.onmessage = (event) => {
            if (!this.isListening || this.rxInstance == null) return;

            const inputData = event.data; 
            const rms = Math.sqrt(
                inputData.reduce((s, v) => s + v * v, 0) / inputData.length,
            );
            this.options.onLevel(rms);

            const bytes = new Uint8Array(
                inputData.buffer,
                inputData.byteOffset,
                inputData.byteLength,
            );
            try {
                const decoded = this.gg.decode(this.rxInstance, bytes);
                if (decoded && decoded.length > 0) {
                    this.options.onMessage(new TextDecoder().decode(decoded));
                }
            } catch (err) {
                this.options.onError(err);
            }
        };

        this.isListening = true;
        this.options.onLog("Listening for ultrasound...");
    }

    stopListening() {
        if (!this.isListening) return;

        this.pipelineCtx?.suspend();
        if (this.pipelineNode) this.pipelineNode.port.onmessage = null;

        if (this.rxInstance != null && this.gg) {
            this.gg.free(this.rxInstance);
            this.rxInstance = null;
        }

        this.isListening = false;
        this.options.onLog("Stopped listening.");
    }

    /** Fully tear down — call on component unmount. */
    async destroy() {
        this.stopListening();
        this.mediaStream?.getTracks().forEach((t) => t.stop());
        if (this.pipelineCtx && this.pipelineCtx.state !== "closed") {
            await this.pipelineCtx.close();
        }
        if (this.playbackCtx && this.playbackCtx.state !== "closed") {
            await this.playbackCtx.close();
        }
        this.pipelineReady = false;
    }
}
