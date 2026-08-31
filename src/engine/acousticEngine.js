// @ts-check
import ggwaveFactory from "@vpalmisano/ggwave";

/**
 * @typedef {Object} AcousticTransceiverOptions
 * @property {number} [payloadLength=32]      Fixed payload length (must match sender/receiver)
 * @property {number} [frequencyHz=18300]     Start frequency in Hz (converted internally to a ggwave bin index)
 * @property {string} [protocol="MT_FASTEST"] ggwave protocol key, e.g. "MT_FASTEST", "ULTRASOUND_NORMAL", "AUDIBLE_NORMAL"
 * @property {number} [volume=10]             Send volume (0-100 as used by ggwave)
 * @property {string} [workletUrl="/audio-worklet-processor.js"]  Path to the AudioWorklet module
 * @property {number} [samplesPerFrame=1024]  ggwave's FFT frame size, used only for the Hz<->bin conversion display
 * @property {(rms: number) => void} [onLevel]        Called on every mic frame with current RMS
 * @property {(message: string) => void} [onMessage]  Called when a payload is successfully decoded
 * @property {(message: string) => void} [onLog]      Called for human-readable status updates
 * @property {(error: Error) => void} [onError]       Called on recoverable errors
 * @property {() => void} [onDecodeAttempt]           Called every time a mic frame is fed to the decoder (proof the RX pipeline is alive)
 */

// ggwave's default FFT frame size. Real frequency of bin N is:
//   hz = N * (sampleRateOut / samplesPerFrame)
// This mirrors ggwave's own hzPerSample() convention. It's an approximation
// tied to ggwave's default parameters — if you ever change samplesPerFrame
// via getDefaultParameters(), pass the same value here so the Hz math stays honest.
const DEFAULT_SAMPLES_PER_FRAME = 1024;
const DEFAULT_FREQUENCY_HZ = 18300; // ~bin 390 at 48kHz, matches the old hardcoded default

export class AcousticTransceiver {
    /** @param {AcousticTransceiverOptions} [options] */
    constructor(options = {}) {
        this.options = {
            payloadLength: 32,
            frequencyHz: DEFAULT_FREQUENCY_HZ,
            protocol: "MT_FASTEST",
            volume: 10,
            workletUrl: "/audio-worklet-processor.js",
            samplesPerFrame: DEFAULT_SAMPLES_PER_FRAME,
            onLevel: () => {},
            onMessage: () => {},
            onLog: () => {},
            onError: () => {},
            onDecodeAttempt: () => {},
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
        this._sendLoopTimer = null;
        this._sendLoopBusy = false;
    }

    /** Update runtime-tunable options (frequencyHz, protocol, volume, callbacks, etc). */
    configure(partialOptions) {
        Object.assign(this.options, partialOptions);
        if (this.gg && (partialOptions.frequencyHz !== undefined || partialOptions.protocol !== undefined)) {
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

    /** Hz per ggwave bin at the given sample rate (defaults to the currently running context, else 48000). */
    hzPerBin(sampleRate) {
        const sr = sampleRate ?? this.pipelineCtx?.sampleRate ?? this.playbackCtx?.sampleRate ?? 48000;
        return sr / this.options.samplesPerFrame;
    }

    /** Convert a Hz value to the nearest ggwave bin index at the given (or current) sample rate. */
    hzToBin(hz, sampleRate) {
        return Math.round(hz / this.hzPerBin(sampleRate));
    }

    /** Convert a ggwave bin index back to an approximate Hz value at the given (or current) sample rate. */
    binToHz(bin, sampleRate) {
        return Math.round(bin * this.hzPerBin(sampleRate));
    }

    _applyFreqStart() {
        const id = this._getProtocolId();
        if (id == null) {
            this.options.onLog(`Protocol "${this.options.protocol}" not found on this ggwave build.`);
            return;
        }
        const bin = this.hzToBin(this.options.frequencyHz);
        this.gg.txProtocolSetFreqStart?.(id, bin);
        this.gg.rxProtocolSetFreqStart?.(id, bin);
    }

    /** Enumerate protocols actually available on this ggwave build, e.g. [{key:"MT_FASTEST", id:11}, ...]. */
    getAvailableProtocols() {
        if (!this.gg) return [];
        const unified = this.gg.ProtocolId || {};
        const legacy = this.gg.TxProtocolId || {};
        const source = Object.keys(unified).length ? unified : legacy;
        const prefix = Object.keys(unified).length ? "GGWAVE_PROTOCOL_" : "GGWAVE_TX_PROTOCOL_";
        return Object.keys(source)
            .filter((k) => k.startsWith(prefix))
            .map((k) => ({ key: k.replace(prefix, ""), id: source[k] }))
            .sort((a, b) => a.id - b.id);
    }

    _getProtocolId() {
        if (!this.gg) return null;
        const unified = this.gg.ProtocolId;
        const legacy = this.gg.TxProtocolId;
        const key = this.options.protocol;
        return (
            unified?.[`GGWAVE_PROTOCOL_${key}`] ??
            legacy?.[`GGWAVE_TX_PROTOCOL_${key}`] ??
            legacy?.[`GGWAVE_PROTOCOL_${key}`] ??
            unified?.GGWAVE_PROTOCOL_MT_FASTEST ??
            legacy?.GGWAVE_TX_PROTOCOL_MT_FASTEST ??
            1
        );
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

        // Sample rate affects the Hz<->bin math, so re-apply freqStart once we know the real rate.
        this._applyFreqStart();

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

    /** Encode and play `payload` through the speakers. Returns { durationMs } of the broadcast. */
    async send(payload) {
        await this.init();

        if (!this.playbackCtx) {
            this.playbackCtx = new (window.AudioContext || window.webkitAudioContext)();
        }
        // Sample rate wasn't known for certain until the context existed; re-apply now.
        this._applyFreqStart();

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
            const durationMs = (floatSamples.length / this.playbackCtx.sampleRate) * 1000;

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

            this.options.onLog(
                `Sent "${payload}" (${this.options.protocol}, ${Math.round(this.options.frequencyHz)}Hz, ${durationMs.toFixed(0)}ms).`,
            );
            return { durationMs };
        } finally {
            this.gg.free(instance);
        }
    }

    /**
     * Repeatedly send `payload` every `gapMs` after each broadcast finishes, until stopSendingLoop() is called.
     * Useful for walking around a room with a second device to test decode range/reliability.
     */
    startSendingLoop(payload, gapMs = 1500) {
        this.stopSendingLoop();
        this._sendLoopBusy = true;

        const tick = async () => {
            if (!this._sendLoopBusy) return;
            try {
                const { durationMs } = await this.send(payload);
                if (!this._sendLoopBusy) return;
                this._sendLoopTimer = setTimeout(tick, durationMs + gapMs);
            } catch (err) {
                this.options.onError(err);
                if (this._sendLoopBusy) {
                    this._sendLoopTimer = setTimeout(tick, gapMs);
                }
            }
        };
        tick();
    }

    stopSendingLoop() {
        this._sendLoopBusy = false;
        if (this._sendLoopTimer) {
            clearTimeout(this._sendLoopTimer);
            this._sendLoopTimer = null;
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
            this.options.onDecodeAttempt();

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
        this.stopSendingLoop();
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
