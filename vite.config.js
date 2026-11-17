import { defineConfig } from "vite";

// The main page (public/index.html) is the Fridgi prototype and is copied as-is.
// The original receipt scanner is built from scanner.html and lives at /scanner.html.
export default defineConfig({
  build: {
    rollupOptions: { input: "scanner.html" },
  },
  plugins: [
    {
      // In `npm run dev`, make "/" open the main page like the live site does.
      name: "serve-public-index",
      configureServer(server) {
        server.middlewares.use((req, _res, next) => {
          if (req.url === "/" || req.url.startsWith("/?")) req.url = "/index.html";
          next();
        });
      },
    },
  ],
});
