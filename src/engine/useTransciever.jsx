import { useEffect, useRef, useState, useCallback } from "react";
import { AcousticTransceiver } from "./acousticEngine";

/**
 * React hook wrapping AcousticTransceiver.
 * Creates one instance per mount, warms up the mic/worklet pipeline eagerly,
 * and tears everything down on unmount.
 *
 * @param {Partial<import("./acousticEngine").AcousticTransceiverOptions>} [options]
 */
export function useAcousticTransceiver(options = {}) {
    const transceiverRef = useRef(null);
    const [isListening, setIsListening] = useState(false);
    const [isSendingLoop, setIsSendingLoop] = useState(false);
    const [level, setLevel] = useState(0);
    const [peakLevel, setPeakLevel] = useState(0);
    const [decodeAttempts, setDecodeAttempts] = useState(0);
    const [logs, setLogs] = useState([]);
    const [messages, setMessages] = useState([]);
    const [lastMessage, setLastMessage] = useState(null);
    const [lastSendDurationMs, setLastSendDurationMs] = useState(null);
    const [availableProtocols, setAvailableProtocols] = useState([]);
    const [ready, setReady] = useState(false);

    // Keep the latest option overrides available without recreating the
    // transceiver instance (and its live mic/AudioContext) on every render.
    const optionsRef = useRef(options);
    optionsRef.current = options;

    useEffect(() => {
        const transceiver = new AcousticTransceiver({
            ...optionsRef.current,
            onLevel: (rms) => {
                setLevel(rms);
                setPeakLevel((prev) => Math.max(prev * 0.97, rms)); // slow-decay peak hold for the meter
            },
            onMessage: (msg) => {
                setLastMessage(msg);
                setMessages((prev) => [...prev, { text: msg, at: Date.now() }]);
            },
            onLog: (msg) => setLogs((prev) => [...prev.slice(-199), { text: msg, at: Date.now() }]),
            onError: (err) =>
                setLogs((prev) => [...prev.slice(-199), { text: `Error: ${err.message}`, at: Date.now(), isError: true }]),
            onDecodeAttempt: () => setDecodeAttempts((prev) => prev + 1),
        });
        transceiverRef.current = transceiver;

        transceiver
            .init()
            .then(() => {
                setAvailableProtocols(transceiver.getAvailableProtocols());
                setReady(true);
            })
            .catch(() => {});

        transceiver.warmUp(); // pays mic/worklet setup cost before the user clicks anything

        return () => {
            transceiver.destroy();
        };
    }, []); // eslint-disable-line react-hooks/exhaustive-deps

    const startListening = useCallback(async () => {
        await transceiverRef.current?.startListening();
        setIsListening(true);
    }, []);

    const stopListening = useCallback(() => {
        transceiverRef.current?.stopListening();
        setIsListening(false);
    }, []);

    const send = useCallback(async (payload) => {
        const result = await transceiverRef.current?.send(payload);
        if (result) setLastSendDurationMs(result.durationMs);
        return result;
    }, []);

    const startSendingLoop = useCallback((payload, gapMs) => {
        transceiverRef.current?.startSendingLoop(payload, gapMs);
        setIsSendingLoop(true);
    }, []);

    const stopSendingLoop = useCallback(() => {
        transceiverRef.current?.stopSendingLoop();
        setIsSendingLoop(false);
    }, []);

    const configure = useCallback((partial) => {
        transceiverRef.current?.configure(partial);
    }, []);

    const clearLogs = useCallback(() => setLogs([]), []);

    return {
        ready,
        isListening,
        isSendingLoop,
        level,
        peakLevel,
        decodeAttempts,
        logs,
        messages,
        lastMessage,
        lastSendDurationMs,
        availableProtocols,
        startListening,
        stopListening,
        send,
        startSendingLoop,
        stopSendingLoop,
        configure,
        clearLogs,
        transceiver: transceiverRef,
    };
}
