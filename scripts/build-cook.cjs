const { mkdirSync } = require('node:fs');
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
mkdirSync(path.join(root, 'bin'), { recursive: true });
const result = spawnSync(process.env.CC || 'cc', ['-O2', '-o', path.join(root, 'bin', 'oggcorrect'), path.join(root, 'cook', 'oggcorrect.c')], { stdio: 'inherit' });
if (result.error) console.error('A C compiler is required to build Craig timestamp correction:', result.error.message);
process.exitCode = result.error ? 1 : result.status ?? 1;
