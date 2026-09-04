import { defineConfig, loadEnv } from "vite";

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "");
  const apiTarget = env.FOLD_API_PROXY_TARGET ?? "http://127.0.0.1:3000";

  return {
    server: {
      host: "127.0.0.1",
      port: 4173,
      proxy: {
        "/api": {
          target: apiTarget,
          changeOrigin: true,
          rewrite: (path) => path.replace(/^\/api/, ""),
        },
        "/capture": {
          target: env.SUPER_BRAIN_CAPTURE_PROXY_TARGET ?? "http://127.0.0.1:8377",
          changeOrigin: true,
          rewrite: (path) => path.replace(/^\/capture/, ""),
        },
      },
    },
  };
});
