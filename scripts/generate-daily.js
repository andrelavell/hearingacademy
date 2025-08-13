#!/usr/bin/env node
import 'dotenv/config';
import { envInt } from './utils/config.js';
import { spawn } from 'node:child_process';

const N = envInt('ARTICLES_PER_DAY', 3);

async function run(cmd, args) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: 'inherit', shell: true });
    p.on('exit', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${cmd} ${args.join(' ')} exited with code ${code}`));
    });
  });
}

async function main() {
  for (let i = 0; i < N; i++) {
    console.log(`[daily] Generating article ${i + 1} of ${N}`);
    await run('node', ['scripts/generate-article.js']);
    // small delay to vary prompts slightly by time
    await new Promise((r) => setTimeout(r, 1000));
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
