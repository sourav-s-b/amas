import { useEffect, useMemo, useRef, useState } from "react";
import { useAcousticTransceiver } from "./engine/useTransciever";
import "./App.css";

const FREQ_MIN = 14000;
const FREQ_MAX = 20000;
const FALLBACK_PROTOCOLS = ["MT_FASTEST", "MT_NORMAL", "ULTRASOUND_FASTEST", "ULTRASOUND_NORMAL", "AUDIBLE_NORMAL"];

function audibilityRisk(hz) {
    if (hz < 17000) {
        return { level: "high", label: "Audible to most people — class will hear this" };
    }
    if (hz < 18500) {
        return { level: "medium", label: "May be audible to some, especially younger students" };
    }
    return { level: "low", label: "Likely inaudible to most people in the room" };
}

export default function App() {
    const {
        ready,
        isListening,
        isSendingLoop,
        level,
        peakLevel,
        decodeAttempts,
        logs,
        messages,
        lastSendDurationMs,
        isSending,
        sendProgress,
        sendTotalMs,
        sendingPayload,
        sampleRates,
        availableProtocols,
        startListening,
        stopListening,
        send,
        startSendingLoop,
        stopSendingLoop,
        configure,
        clearLogs,
    } = useAcousticTransceiver({
        payloadLength: 32,
        frequencyHz: 18300,
        protocol: "MT_FASTEST",
        volume: 10,
    });

    const [payload, setPayload] = useState("ATTEND-042");
    const [frequencyHz, setFrequencyHz] = useState(18300);
    const [volume, setVolume] = useState(10);
    const [protocol, setProtocol] = useState("MT_FASTEST");
    const [loopGapSec, setLoopGapSec] = useState(1.5);

    const logEndRef = useRef(null);

    const protocolOptions = availableProtocols.length
        ? availableProtocols.map((p) => p.key)
        : FALLBACK_PROTOCOLS;

    const risk = useMemo(() => audibilityRisk(frequencyHz), [frequencyHz]);

    useEffect(() => {
        configure({ frequencyHz });
    }, [frequencyHz, configure]);

    useEffect(() => {
        configure({ volume });
    }, [volume, configure]);

    useEffect(() => {
        configure({ protocol });
    }, [protocol, configure]);

    useEffect(() => {
        logEndRef.current?.scrollIntoView({ block: "nearest" });
    }, [logs]);

    const handleSendOnce = () => {
        send(payload);
    };

    const handleToggleLoop = () => {
        if (isSendingLoop) {
            stopSendingLoop();
        } else {
            startSendingLoop(payload, Math.max(200, loopGapSec * 1000));
        }
    };

    const meterPct = Math.min(100, level * 400);
    const peakPct = Math.min(100, peakLevel * 400);

    return (
        <div className="console">
            <header className="console-header">
                <div>
                    <h1>Signal test console</h1>
                    <p className="subtitle">Tune range and confirm nothing bleeds into the room before you run this live.</p>
                </div>
                <div className={`risk-chip risk-${risk.level}`}>
                    <span className="risk-dot" />
                    {risk.label}
                </div>
            </header>

            <div className="strips">
                {/* TX CHANNEL */}
                <section className="strip">
                    <div className="strip-head">
                        <span className="strip-tag tag-tx">TX</span>
                        <h2>Transmit</h2>
                        {sampleRates.playback != null && (
                            <span className="ctx-rate mono">{sampleRates.playback} Hz</span>
                        )}
                    </div>
                    {sampleRates.pipeline != null &&
                        sampleRates.playback != null &&
                        sampleRates.pipeline !== sampleRates.playback && (
                            <p className="rate-mismatch">
                                ⚠️ Mic ({sampleRates.pipeline}Hz) and speaker ({sampleRates.playback}Hz) contexts
                                disagree on this device — outgoing tones can end up detuned from the Hz shown below,
                                worse at higher frequencies.
                            </p>
                        )}

                    <label className="field">
                        <span>Payload</span>
                        <input
                            type="text"
                            value={payload}
                            onChange={(e) => setPayload(e.target.value)}
                            placeholder="e.g. ATTEND-042"
                        />
                    </label>

                    <label className="field">
                        <span>Protocol</span>
                        <select value={protocol} onChange={(e) => setProtocol(e.target.value)}>
                            {protocolOptions.map((key) => (
                                <option key={key} value={key}>
                                    {key}
                                </option>
                            ))}
                        </select>
                    </label>

                    <div className="field">
                        <span className="slider-label">
                            Frequency <strong>{frequencyHz.toLocaleString()} Hz</strong>
                        </span>
                        <input
                            type="range"
                            min={FREQ_MIN}
                            max={FREQ_MAX}
                            step={50}
                            value={frequencyHz}
                            onChange={(e) => setFrequencyHz(Number(e.target.value))}
                            className={`slider slider-${risk.level}`}
                        />
                        <div className="slider-scale">
                            <span>{FREQ_MIN / 1000}kHz · audible</span>
                            <span>{FREQ_MAX / 1000}kHz · ultrasonic</span>
                        </div>
                        <p className="hint">
                            Drag down to ~15–16kHz to actually hear the tone and judge how long a message takes —
                            then push it back above 18.5kHz before testing on real students.
                        </p>
                    </div>

                    <div className="field">
                        <span className="slider-label">
                            Volume <strong>{volume}</strong>
                        </span>
                        <input
                            type="range"
                            min={0}
                            max={100}
                            value={volume}
                            onChange={(e) => setVolume(Number(e.target.value))}
                            className="slider slider-neutral"
                        />
                    </div>

                    <div className="button-row">
                        <button className="btn btn-primary" onClick={handleSendOnce} disabled={!ready}>
                            {isSending ? "Sending…" : "Send once"}
                        </button>
                        <button
                            className={`btn ${isSendingLoop ? "btn-danger" : "btn-secondary"}`}
                            onClick={handleToggleLoop}
                            disabled={!ready}
                        >
                            {isSendingLoop ? "Stop sending loop" : "Start sending loop"}
                        </button>
                    </div>

                    <label className="field field-inline">
                        <span>Loop gap (s)</span>
                        <input
                            type="number"
                            min={0.2}
                            step={0.1}
                            value={loopGapSec}
                            onChange={(e) => setLoopGapSec(Number(e.target.value))}
                        />
                    </label>

                    <div className="send-progress-block">
                        <div className="send-progress-labels">
                            <span>
                                {isSending
                                    ? `Broadcasting "${sendingPayload}"`
                                    : lastSendDurationMs != null
                                      ? "Last broadcast"
                                      : "No broadcast yet"}
                            </span>
                            <span className="mono">{Math.round(sendProgress * 100)}%</span>
                        </div>
                        <div className="send-progress-track">
                            <div
                                className={`send-progress-fill ${isSending ? "" : "send-progress-fill-idle"}`}
                                style={{ width: `${Math.round(sendProgress * 100)}%` }}
                            />
                        </div>
                        <p className="hint">
                            {isSending
                                ? `${Math.round(sendProgress * sendTotalMs)}ms / ${sendTotalMs.toFixed(0)}ms — changing frequency or protocol will stop this broadcast; volume updates live.`
                                : lastSendDurationMs != null
                                  ? `Last broadcast took ${lastSendDurationMs.toFixed(0)}ms.`
                                  : "Send a payload to see its transmission progress here."}
                        </p>
                    </div>
                </section>

                {/* RX CHANNEL */}
                <section className="strip">
                    <div className="strip-head">
                        <span className="strip-tag tag-rx">RX</span>
                        <h2>Receive</h2>
                        {sampleRates.pipeline != null && (
                            <span className="ctx-rate mono">{sampleRates.pipeline} Hz</span>
                        )}
                    </div>

                    <button
                        className={`btn ${isListening ? "btn-danger" : "btn-primary"} btn-block`}
                        onClick={isListening ? stopListening : startListening}
                        disabled={!ready}
                    >
                        {isListening ? "Stop listening" : "Start listening"}
                    </button>

                    <div className="meter-block">
                        <div className="meter-labels">
                            <span>Mic level (RMS)</span>
                            <span className="mono">{level.toFixed(5)}</span>
                        </div>
                        <div className="meter-track">
                            <div className="meter-fill" style={{ width: `${meterPct}%` }} />
                            <div className="meter-peak" style={{ left: `${peakPct}%` }} />
                        </div>
                    </div>

                    <div className="stat-row">
                        <div className="stat">
                            <span className="stat-label">Decode attempts</span>
                            <span className="stat-value mono">{decodeAttempts}</span>
                        </div>
                        <div className="stat">
                            <span className="stat-label">Messages decoded</span>
                            <span className="stat-value mono">{messages.length}</span>
                        </div>
                    </div>

                    <div className="message-list">
                        {messages.length === 0 && <p className="empty">No payload decoded yet.</p>}
                        {messages
                            .slice()
                            .reverse()
                            .slice(0, 6)
                            .map((m, i) => (
                                <div className="message-item" key={m.at + "-" + i}>
                                    <span className="mono">{m.text}</span>
                                    <span className="message-time">{new Date(m.at).toLocaleTimeString()}</span>
                                </div>
                            ))}
                    </div>
                </section>
            </div>

            <section className="log-console">
                <div className="log-head">
                    <h2>Log</h2>
                    <button className="btn btn-ghost" onClick={clearLogs}>
                        Clear
                    </button>
                </div>
                <div className="log-body">
                    {logs.map((l, i) => (
                        <div key={l.at + "-" + i} className={`log-line ${l.isError ? "log-error" : ""}`}>
                            <span className="log-time">{new Date(l.at).toLocaleTimeString()}</span>
                            <span>{l.text}</span>
                        </div>
                    ))}
                    <div ref={logEndRef} />
                </div>
            </section>
        </div>
    );
}