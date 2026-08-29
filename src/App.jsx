import { useAcousticTransceiver } from "./engine/useTransciever";

export default function App() {
    const {
        isListening,
        level,
        logs,
        lastMessage,
        startListening,
        stopListening,
        send,
    } = useAcousticTransceiver({
        payloadLength: 32,
        freqStart: 390,
        volume: 10,
    });

    return (
        <div style={{ fontFamily: "sans-serif", padding: 16 }}>
            <h1>Ultrasound Transceiver</h1>

            <button onClick={() => send("M")}>Send "M"</button>{" "}
            <button onClick={isListening ? stopListening : startListening}>
                {isListening ? "Stop Listening" : "Start Listening"}
            </button>

            <p>Mic level (RMS): {level.toFixed(5)}</p>
            {lastMessage && <p>🎯 Received: {lastMessage}</p>}

            <pre style={{ background: "#f4f4f4", padding: 10, marginTop: 10 }}>
                {logs.join("\n")}
            </pre>
        </div>
    );
}
