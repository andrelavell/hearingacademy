// @ts-check
import { defineConfig } from 'astro/config';
import netlify from '@astrojs/netlify/functions';

// https://astro.build/config
export default defineConfig({
  site: 'https://hearingacademy.org',
  compressHTML: true,
  adapter: netlify(),
  output: 'server',
  build: {
    inlineStylesheets: 'auto'
  }
});
