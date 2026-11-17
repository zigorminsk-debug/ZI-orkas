'use strict';

const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { assertExecutableArch } = require('../bin/runtime-gate.cjs');
const { sharpPreparationFiles } = require('../bin/native-package-gate.cjs');
const {
  ensureFile,
  packagePath,
  packageVersion,
  readElectronVersion,
  readLockPackage,
} = require('./native-prepare-cache.cjs');

const PC_DIR = path.resolve(__dirname, '..');
const LOCK_FILE = path.join(PC_DIR, 'package-lock.json');

function targetArchFromArgs() {
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--arch' && argv[i + 1]) return argv[i + 1];
    if (argv[i].startsWith('--arch=')) return argv[i].slice('--arch='.length);
  }
  return process.arch === 'arm64' ? 'arm64' : 'x64';
}

function run(cwd, command, args) {
  const result = spawnSync(command, args, {
    cwd,
    stdio: 'inherit',
    shell: false,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} failed with exit code ${result.status}`);
  }
}

function npmPack(cwd, spec) {
  const result = spawnSync('npm', ['pack', spec, '--json'], {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`npm pack ${spec} failed with exit code ${result.status}`);
  }
  const packs = JSON.parse(result.stdout);
  const filename = packs?.[0]?.filename;
  if (!filename) {
    throw new Error(`npm pack ${spec} did not report an output filename`);
  }
  return path.join(cwd, filename);
}

function ensureLockedPlatformPackage(packageName, relativeBinaries, targetArch) {
  const lockEntry = readLockPackage(LOCK_FILE, `node_modules/${packageName}`);
  const expectedVersion = lockEntry.version;
  const targetDir = packagePath(PC_DIR, packageName);
  const files = relativeBinaries.map((rel) => path.join(targetDir, ...rel.split('/')));

  const alreadyValid = packageVersion(targetDir) === expectedVersion
    && files.every((file) => fs.existsSync(file) && fs.statSync(file).isFile());
  if (!alreadyValid) {
    console.log(`[prepare-linux-native-deps] unpacking ${packageName}@${expectedVersion}`);
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zi-orkas-linux-pkg-'));
    try {
      const tarball = npmPack(tmpDir, `${packageName}@${expectedVersion}`);
      fs.rmSync(targetDir, { recursive: true, force: true });
      fs.mkdirSync(targetDir, { recursive: true });
      run(targetDir, 'tar', ['-xzf', tarball, '--strip-components=1']);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  }

  for (const file of files) {
    ensureFile(`${packageName} native payload`, file);
    assertExecutableArch(file, 'linux', targetArch);
  }
  console.log(`[prepare-linux-native-deps] verified ${packageName}@${expectedVersion}`);
}

function rebuildBetterSqlite3(targetArch) {
  const electronVersion = readElectronVersion(PC_DIR);
  const rebuildCli = path.join(PC_DIR, 'node_modules', '@electron', 'rebuild', 'lib', 'cli.js');
  ensureFile('@electron/rebuild CLI', rebuildCli);
  console.log(`[prepare-linux-native-deps] rebuilding better-sqlite3 for Electron ${electronVersion} linux-${targetArch}`);
  run(PC_DIR, process.execPath, [
    rebuildCli,
    '-f',
    '-w', 'better-sqlite3',
    '-v', electronVersion,
    '-a', targetArch,
  ]);
  const testExt = path.join(PC_DIR, 'node_modules', 'better-sqlite3', 'build', 'Release', 'test_extension.node');
  fs.rmSync(testExt, { recursive: true, force: true });
  const binding = path.join(PC_DIR, 'node_modules', 'better-sqlite3', 'build', 'Release', 'better_sqlite3.node');
  ensureFile('better-sqlite3 native binding', binding);
  assertExecutableArch(binding, 'linux', targetArch);
}

function verifyOnnxRuntime(targetArch) {
  const candidates = [
    path.join(PC_DIR, 'node_modules', 'onnxruntime-node'),
    path.join(PC_DIR, 'node_modules', 'fastembed', 'node_modules', 'onnxruntime-node'),
  ].filter((dir) => fs.existsSync(dir));
  if (candidates.length === 0) {
    throw new Error('[prepare-linux-native-deps] onnxruntime-node is missing from node_modules');
  }
  for (const pkgDir of candidates) {
    const binding = path.join(pkgDir, 'bin', 'napi-v3', 'linux', targetArch, 'onnxruntime_binding.node');
    ensureFile('onnxruntime-node Linux binding', binding);
    assertExecutableArch(binding, 'linux', targetArch);
  }
}

function main() {
  const targetArch = targetArchFromArgs();
  if (targetArch !== 'x64' && targetArch !== 'arm64') {
    throw new Error(`[prepare-linux-native-deps] unsupported Linux arch: ${targetArch}`);
  }

  // Remove fsevents if present (macOS-only).
  fs.rmSync(path.join(PC_DIR, 'node_modules', 'fsevents'), { recursive: true, force: true });

  const sharpLock = readLockPackage(LOCK_FILE, `node_modules/@img/sharp-linux-${targetArch}`);
  const sharpFiles = sharpPreparationFiles('linux', targetArch, sharpLock.version);
  const stripPkg = (pkg, rel) => rel.slice(pkg.length + 1);

  ensureLockedPlatformPackage(`@esbuild/linux-${targetArch}`, ['bin/esbuild'], targetArch);
  ensureLockedPlatformPackage(`sqlite-vec-linux-${targetArch}`, ['vec0.so'], targetArch);
  ensureLockedPlatformPackage(`@napi-rs/canvas-linux-${targetArch}-gnu`, [`skia.linux-${targetArch}-gnu.node`], targetArch);
  ensureLockedPlatformPackage(`@anush008/tokenizers-linux-${targetArch}-gnu`, [`tokenizers.linux-${targetArch}-gnu.node`], targetArch);
  ensureLockedPlatformPackage(`@img/sharp-linux-${targetArch}`, [stripPkg(`@img/sharp-linux-${targetArch}`, sharpFiles.binding)], targetArch);
  ensureLockedPlatformPackage(`@img/sharp-libvips-linux-${targetArch}`, [stripPkg(`@img/sharp-libvips-linux-${targetArch}`, sharpFiles.cpp)], targetArch);

  verifyOnnxRuntime(targetArch);
  rebuildBetterSqlite3(targetArch);
  console.log(`[prepare-linux-native-deps] all linux-${targetArch} native dependencies ready`);
}

if (require.main === module) {
  main();
}
