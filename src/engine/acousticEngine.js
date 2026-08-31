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

// We always encode at this fixed ggwave "volume" and do real volume control with a
// Web Audio GainNode instead. That's what lets the volume slider apply live, mid-broadcast,
// without re-encoding the waveform (frequency/protocol changes still require re-encoding).
const ENCODE_BASELINE_VOLUME = 50;

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
            onSendStart: () => {},
            onSendProgress: () => {},
            onSendEnd: () => {},
            onSendInterrupted: () => {},
            onSampleRates: () => {},
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

        this.playbackGain = null;
        this._currentSource = null;
        this._sendProgressRAF = null;
        this._currentPayload = null;
    }

    /** Update runtime-tunable options (frequencyHz, protocol, volume, callbacks, etc). */
    configure(partialOptions) {
        const changesFreqOrProtocol =
            partialOptions.frequencyHz !== undefined || partialOptions.protocol !== undefined;
        const changesVolume = partialOptions.volume !== undefined;

        Object.assign(this.options, partialOptions);

        // Volume is applied live via the GainNode — no need to interrupt anything in flight.
        if (changesVolume && this.playbackGain) {
            this.playbackGain.gain.value = this._volumeToGain(this.options.volume);
        }

        if (changesFreqOrProtocol) {
            // This reapplies freqStart against whichever context currently exists, purely so
            // getAvailableProtocols()/logs reflect the new value immediately. It is NOT what makes
            // TX/RX correct — send() and startListening() each reapply it with their own context's
            // exact sample rate right before use, which is what actually matters.
            if (this.gg) {
                this._applyFreqStart(this.playbackCtx?.sampleRate ?? this.pipelineCtx?.sampleRate);
            }
            // Frequency/protocol changes affect how the waveform is encoded, so a signal
            // already playing (or queued in the sending loop) is now stale. Stop it rather
            // than let a half-old, half-new tone go out the speaker.
            const wasActive = !!this._currentSource || this._sendLoopBusy;
            if (wasActive) {
                const wasLooping = this._sendLoopBusy;
                this._stopCurrentSource();
                this.stopSendingLoop();
                this.options.onLog(
                    `${partialOptions.frequencyHz !== undefined ? "Frequency" : "Protocol"} changed — stopped ${
                        wasLooping ? "sending loop" : "active transmission"
                    }.`,
                );
                this.options.onSendInterrupted();
            }
        }
    }

    /** Map the 0-100 UI volume slider to a GainNode value (0-2x, since encode uses a fixed baseline). */
    _volumeToGain(volume) {
        return Math.max(0, volume / 50);
    }

    /**
     * Surface the mic (pipelineCtx) and speaker (playbackCtx) sample rates to the UI, and warn
     * loudly if they differ — that mismatch is exactly what can detune TX relative to what RX is
     * listening for, especially at higher frequencies. Call this whenever either context is created.
     */
    _reportSampleRates() {
        const pipeline = this.pipelineCtx?.sampleRate ?? null;
        const playback = this.playbackCtx?.sampleRate ?? null;
        this.options.onSampleRates({ pipeline, playback });
        if (pipeline != null && playback != null && pipeline !== playback) {
            this.options.onLog(
                `⚠️ Mic (${pipeline}Hz) and speaker (${playback}Hz) contexts are running at different sample rates on this device. This can detune outgoing tones — most noticeably at higher frequencies.`,
            );
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

    /** Hz per ggwave bin at the given sample rate. Always pass an explicit rate from the call site
     *  that's about to use it — TX must use playbackCtx.sampleRate, RX must use pipelineCtx.sampleRate.
     *  Falling back silently between the two is what caused TX/RX to disagree on frequency. */
    hzPerBin(sampleRate) {
        const sr = sampleRate ?? 48000;
        return sr / this.options.samplesPerFrame;
    }

    /** Convert a Hz value to the nearest ggwave bin index at the given sample rate. */
    hzToBin(hz, sampleRate) {
        return Math.round(hz / this.hzPerBin(sampleRate));
    }

    /** Convert a ggwave bin index back to an approximate Hz value at the given sample rate. */
    binToHz(bin, sampleRate) {
        return Math.round(bin * this.hzPerBin(sampleRate));
    }

    /**
     * Set ggwave's freqStart for the requested Hz, at `sampleRate`.
     * freqStart is a GLOBAL setting in the ggwave module (shared by every TX/RX instance), so
     * this must be called with the sample rate of whichever context is about to actually run —
     * playbackCtx.sampleRate right before send(), pipelineCtx.sampleRate right before listen().
     * Calling it with the wrong context's rate is exactly what silently detunes the broadcast.
     */
    _applyFreqStart(sampleRate) {
        const id = this._getProtocolId();
        if (id == null) {
            this.options.onLog(`Protocol "${this.options.protocol}" not found on this ggwave build.`);
            return;
        }
        const sr = sampleRate ?? 48000;
        const bin = this.hzToBin(this.options.frequencyHz, sr);
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
        // This must use pipelineCtx's own rate — it's about to be the rate passed to gg.init() below.
        this._applyFreqStart(this.pipelineCtx.sampleRate);
        this._reportSampleRates();

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

    /**
     * Encode and play `payload` through the speakers. Returns { durationMs } of the broadcast.
     * Fires onSendStart/onSendProgress/onSendEnd as it plays so the UI can render a progress bar.
     * If a transmission is already in flight, it's cut off in favor of this new one.
     */
    async send(payload) {
        await this.init();

        if (!this.playbackCtx) {
            this.playbackCtx = new (window.AudioContext || window.webkitAudioContext)();
            this.playbackGain = this.playbackCtx.createGain();
            this.playbackGain.gain.value = this._volumeToGain(this.options.volume);
            this.playbackGain.connect(this.playbackCtx.destination);
            this._reportSampleRates();
        }
        // Sample rate wasn't known for certain until the context existed; re-apply now.
        // Must use playbackCtx's own rate — it's what gg.init() below is told a moment later.
        // (Previously this silently picked up pipelineCtx's rate instead when the mic pipeline
        // was already warmed up, so TX could be detuned from the requested Hz — worse at higher
        // frequencies, which is why 19kHz was hit hardest.)
        this._applyFreqStart(this.playbackCtx.sampleRate);

        const parameters = this.gg.getDefaultParameters();
        parameters.sampleRateInp = this.playbackCtx.sampleRate;
        parameters.sampleRateOut = this.playbackCtx.sampleRate;
        parameters.payloadLength = this.options.payloadLength;

        const instance = this.gg.init(parameters);
        let audioBuffer, durationMs;
        try {
            const waveform = this.gg.encode(
                instance,
                payload,
                this._getProtocolId(),
                ENCODE_BASELINE_VOLUME,
            );
            if (!waveform) {
                throw new Error("Failed to encode payload.");
            }

            const floatSamples = new Float32Array(
                waveform.buffer,
                waveform.byteOffset,
                waveform.byteLength / 4,
            );
            durationMs = (floatSamples.length / this.playbackCtx.sampleRate) * 1000;

            audioBuffer = this.playbackCtx.createBuffer(
                1,
                floatSamples.length,
                this.playbackCtx.sampleRate,
            );
            audioBuffer.getChannelData(0).set(floatSamples);
        } finally {
            this.gg.free(instance);
        }

        // Cut off whatever was still playing so we never overlap two transmissions.
        this._stopCurrentSource();

        const source = this.playbackCtx.createBufferSource();
        source.buffer = audioBuffer;
        source.connect(this.playbackGain);
        this.playbackGain.gain.value = this._volumeToGain(this.options.volume);

        this._currentSource = source;
        this._currentPayload = payload;

        source.onended = () => {
            if (this._currentSource === source) this._currentSource = null;
            this._stopSendProgressTracking();
            this.options.onSendProgress(1);
            this.options.onSendEnd();
        };

        const startedAt = this.playbackCtx.currentTime;
        source.start(0);

        this.options.onSendStart(durationMs, payload);
        this._trackSendProgress(startedAt, durationMs / 1000);

        this.options.onLog(
            `Sending "${payload}" (${this.options.protocol}, ${Math.round(this.options.frequencyHz)}Hz, ${durationMs.toFixed(0)}ms).`,
        );
        return { durationMs };
    }

    /** Stop whatever is currently playing (used before starting a new send, or on interrupt). */
    _stopCurrentSource() {
        if (this._currentSource) {
            try {
                this._currentSource.onended = null;
                this._currentSource.stop();
            } catch {
                // already stopped/ended — fine to ignore
            }
            this._currentSource = null;
        }
        this._stopSendProgressTracking();
    }

    /** Drive onSendProgress(0..1) every animation frame for the duration of the current broadcast. */
    _trackSendProgress(startedAt, durationSec) {
        this._stopSendProgressTracking();
        const tick = () => {
            if (!this.playbackCtx) return;
            const elapsed = this.playbackCtx.currentTime - startedAt;
            const frac = durationSec > 0 ? Math.min(1, elapsed / durationSec) : 1;
            this.options.onSendProgress(frac);
            if (frac < 1) {
                this._sendProgressRAF = requestAnimationFrame(tick);
            } else {
                this._sendProgressRAF = null;
            }
        };
        this._sendProgressRAF = requestAnimationFrame(tick);
    }

    _stopSendProgressTracking() {
        if (this._sendProgressRAF != null) {
            cancelAnimationFrame(this._sendProgressRAF);
            this._sendProgressRAF = null;
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

        // freqStart is a global setting shared with TX — a send() in between could have left it
        // pointed at playbackCtx's rate. Reassert it for pipelineCtx's rate right before decoding.
        this._applyFreqStart(this.pipelineCtx.sampleRate);

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
        this._stopCurrentSource();
        this.stopListening();
        this.mediaStream?.getTracks().forEach((t) => t.stop());
        if (this.pipelineCtx && this.pipelineCtx.state !== "closed") {
            await this.pipelineCtx.close();
        }
        if (this.playbackCtx && this.playbackCtx.state !== "closed") {
            await this.playbackCtx.close();
        }
        this.playbackGain = null;
        this.pipelineReady = false;
    }
}