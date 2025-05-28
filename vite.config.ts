// vite.config.ts
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'path';


export default defineConfig({
  plugins: [react()],
  root: path.resolve(__dirname, 'webview'), // Tell Vite the root of the webview source files
  base: './',
  build: {
    outDir: path.resolve(__dirname, 'dist/webview'), // Output to projectRoot/dist/webview
    emptyOutDir: true,
    rollupOptions: {
      input: { // Define a named input if necessary, or just the HTML file
        main: path.resolve(__dirname, 'webview/index.html')
      },
      output: {
        // Ensure assets go into an 'assets' folder directly under outDir
        entryFileNames: 'assets/[name].js',
        chunkFileNames: 'assets/[name].js',
        assetFileNames: 'assets/[name].[ext]'
      }
    },
    // Important: Vite copies files from publicDir by default.
    // If webview/index.html is your main entry, you might not need a publicDir for this part.
    // publicDir: false, // If you don't want anything from a 'public' folder copied
  }
});