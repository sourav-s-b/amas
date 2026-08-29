import { defineConfig } from "vite";
import { resolve } from "path";
import react from "@vitejs/plugin-react";
import basicSsl from "@vitejs/plugin-basic-ssl";

export default defineConfig({
    plugins: [react(), basicSsl()],
    server: {
        port: 3000,
        host: "0.0.0.0",
    },
    resolve: {
        alias: {
            "@engine": resolve(import.meta.dirname, "src/engine"),
        },
    },
});