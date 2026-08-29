import { useEffect, useRef, useState, useCallback } from "react";
import { AcousticTransceiver } from "./acousticEngine";

/**
 * React hook wrapping AcousticTransceiver.
 * Creates one instance per mount, warms up the mic/worklet pipeline eagerly,
 * and tears everything down on unmount.
 *
 * @param {Partial<import("./AcousticTransceiver").AcousticTransceiverOptions>} [options]
 */
export function useAcousticTransceiver(options = {}) {
    const transceiverRef = useRef(null);
    const [isListening, setIsListening] = useState(false);
    const [level, setLevel] = useState(0);
    const [logs, setLogs] = useState([]);
    const [lastMessage, setLastMessage] = useState(null);

    // Keep the latest option overrides available without recreating the
    // transceiver instance (and its live mic/AudioContext) on every render.
    const optionsRef = useRef(options);
    optionsRef.current = options;

    useEffect(() => {
        const transceiver = new AcousticTransceiver({
            ...optionsRef.current,
            onLevel: (rms) => setLevel(rms),
            onMessage: (msg) => setLastMessage(msg),
            onLog: (msg) => setLogs((prev) => [...prev, msg]),
            onError: (err) => setLogs((prev) => [...prev, `Error: ${err.message}`]),
        });
        transceiverRef.current = transceiver;

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

    const send = useCallback((payload) => {
        return transceiverRef.current?.send(payload);
    }, []);

    const configure = useCallback((partial) => {
        transceiverRef.current?.configure(partial);
    }, []);

    return {
        isListening,
        level,
        logs,
        lastMessage,
        startListening,
        stopListening,
        send,
        configure,
    };
}
