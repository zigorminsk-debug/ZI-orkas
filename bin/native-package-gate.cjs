#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { assertExecutableArch } = require('./runtime-gate.cjs');

// Single source of truth for native files shipped from node_modules. The gate
// is deliberately closed-world: adding a new .node/.dll/.dylib/.so or esbuild
// executable to the packaged app fails until it is registered here. This keeps
// afterPack and final-artifact validation aligned with the app's real payload.
const TARGETS = new Set(['darwin-arm64', 'darwin-x64', 'win32-x64', 'linux-x64', 'linux-arm64']);

function targetKey(platform, arch) {
  return `${platform}-${arch}`;
}

function slash(value) {
  return value.split(path.sep).join('/');
}

function joinRelative(...parts) {
  return parts.filter(Boolean).join('/');
}

function isFile(file) {
  return fs.existsSync(file) && fs.statSync(file).isFile();
}

function readJson(label, file) {
  if (!isFile(file)) {
    throw new Error(`[native-package-gate] missing ${label}: ${file}`);
  }
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    throw new Error(`[native-package-gate] invalid ${label}: ${file}: ${err.message}`);
  }
}

function firstExistingFile(nodeModules, label, candidates) {
  const existing = candidates.filter((relativePath) => isFile(path.join(nodeModules, ...relativePath.split('/'))));
  if (existing.length !== 1) {
    const detail = existing.length === 0
      ? `none of ${candidates.join(', ')}`
      : `multiple candidates: ${existing.join(', ')}`;
    throw new Error(`[native-package-gate] expected exactly one ${label}; found ${detail}`);
  }
  return existing[0];
}

function onnxRuntimePackage(nodeModules) {
  const packageJson = firstExistingFile(nodeModules, 'FastEmbed onnxruntime-node package.json', [
    'fastembed/node_modules/onnxruntime-node/package.json',
    'onnxruntime-node/package.json',
  ]);
  const pkg = readJson(
    'FastEmbed onnxruntime-node package.json',
    path.join(nodeModules, ...packageJson.split('/')),
  );
  if (!/^\d+\.\d+\.\d+(?:[-+].+)?$/.test(String(pkg.version || ''))) {
    throw new Error(`[native-package-gate] invalid FastEmbed onnxruntime-node version: ${pkg.version || '(missing)'}`);
  }
  return {
    base: packageJson.slice(0, -'/package.json'.length),
    version: String(pkg.version).split(/[-+]/, 1)[0],
  };
}

// Shared by preparation, early archive preflight, afterPack and final validation.
// The first companion candidate is the current build requirement; remaining
// candidates preserve validation of older release artifacts.
function sharpNativeContract(platform, arch) {
  if (!TARGETS.has(targetKey(platform, arch))) {
    throw new Error(`[native-package-gate] unsupported Sharp target: ${platform}-${arch}`);
  }
  const mac = platform === 'darwin';
  const linux = platform === 'linux';
  const specs = [
    {
      id: 'sharp-binding',
      candidates: mac
        ? [
            `@img/sharp-darwin-${arch}/lib/sharp-darwin-${arch}-0.35.5.node`,
            `@img/sharp-darwin-${arch}/lib/sharp-darwin-${arch}-0.35.4.node`,
            `@img/sharp-darwin-${arch}/lib/sharp-darwin-${arch}-0.35.3.node`,
            `@img/sharp-darwin-${arch}/lib/sharp-darwin-${arch}.node`,
          ]
        : linux
          ? [
              `@img/sharp-linux-${arch}/lib/sharp-linux-${arch}-0.35.5.node`,
              `@img/sharp-linux-${arch}/lib/sharp-linux-${arch}-0.35.4.node`,
              `@img/sharp-linux-${arch}/lib/sharp-linux-${arch}-0.35.3.node`,
              `@img/sharp-linux-${arch}/lib/sharp-linux-${arch}.node`,
            ]
          : [
              '@img/sharp-win32-x64/lib/sharp-win32-x64-0.35.5.node',
              '@img/sharp-win32-x64/lib/sharp-win32-x64-0.35.4.node',
              '@img/sharp-win32-x64/lib/sharp-win32-x64-0.35.3.node',
              '@img/sharp-win32-x64/lib/sharp-win32-x64.node',
            ],
    },
    {
      id: 'sharp-libvips-cpp',
      candidates: mac
        ? [
            `@img/sharp-libvips-darwin-${arch}/lib/libvips-cpp.8.18.7.dylib`,
            `@img/sharp-libvips-darwin-${arch}/lib/libvips-cpp.8.18.6.dylib`,
            `@img/sharp-libvips-darwin-${arch}/lib/libvips-cpp.8.18.3.dylib`,
            `@img/sharp-libvips-darwin-${arch}/lib/libvips-cpp.8.17.3.dylib`,
          ]
        : linux
          ? [
              `@img/sharp-libvips-linux-${arch}/lib/libvips-cpp.so.8.18.7`,
              `@img/sharp-libvips-linux-${arch}/lib/libvips-cpp.so.8.18.6`,
              `@img/sharp-libvips-linux-${arch}/lib/libvips-cpp.so.8.18.3`,
              `@img/sharp-libvips-linux-${arch}/lib/libvips-cpp.so.8.17.3`,
            ]
          : [
              '@img/sharp-win32-x64/lib/libvips-cpp-8.18.7.dll',
              '@img/sharp-win32-x64/lib/libvips-cpp-8.18.6.dll',
              '@img/sharp-win32-x64/lib/libvips-cpp-8.18.3.dll',
              '@img/sharp-win32-x64/lib/libvips-cpp-8.17.3.dll',
            ],
    },
  ];
  if (platform === 'win32') specs.push({ id: 'sharp-libvips', candidates: ['@img/sharp-win32-x64/lib/libvips-42.dll'] });
  return specs;
}

function sharpPreparationFiles(platform, arch, version) {
  const specs = sharpNativeContract(platform, arch);
  if (!/^\d+\.\d+\.\d+$/.test(String(version || ''))) {
    throw new Error('[native-package-gate] missing concrete locked Sharp version');
  }
  return {
    binding: `@img/sharp-${platform}-${arch}/lib/sharp-${platform}-${arch}-${version}.node`,
    cpp: specs.find(spec => spec.id === 'sharp-libvips-cpp').candidates[0],
    ...(platform === 'win32' ? { libvips: specs.find(spec => spec.id === 'sharp-libvips').candidates[0] } : {}),
  };
}

function nativePackageContract(nodeModules, platform, arch, onnxRuntime = null) {
  const key = targetKey(platform, arch);
  if (!TARGETS.has(key)) {
    throw new Error(`[native-package-gate] unsupported packaged native target: ${key}`);
  }

  onnxRuntime ||= onnxRuntimePackage(nodeModules);

  const mac = platform === 'darwin';
  const linux = platform === 'linux';
  const esbuildPackage = mac ? `darwin-${arch}` : linux ? `linux-${arch}` : 'win32-x64';
  const sqlitePackage = mac ? `sqlite-vec-darwin-${arch}` : linux ? `sqlite-vec-linux-${arch}` : 'sqlite-vec-windows-x64';
  const sqliteLib = mac ? 'vec0.dylib' : linux ? 'vec0.so' : 'vec0.dll';
  const canvasPackage = mac ? `canvas-darwin-${arch}` : linux ? `canvas-linux-${arch}-gnu` : 'canvas-win32-x64-msvc';
  const canvasLib = mac ? `skia.darwin-${arch}.node` : linux ? `skia.linux-${arch}-gnu.node` : 'skia.win32-x64-msvc.node';
  const tokenizersPackage = mac ? 'tokenizers-darwin-universal' : linux ? `tokenizers-linux-${arch}-gnu` : 'tokenizers-win32-x64-msvc';
  const tokenizersLib = mac ? 'tokenizers.darwin-universal.node' : linux ? `tokenizers.linux-${arch}-gnu.node` : 'tokenizers.win32-x64-msvc.node';
  const onnxBase = `${onnxRuntime.base}/bin/napi-v3/${platform}/${arch}`;
  const onnxVersion = onnxRuntime.version;
  const onnxCoreLib = mac
    ? `libonnxruntime.${onnxVersion}.dylib`
    : linux
      ? `libonnxruntime.so.${onnxVersion}`
      : 'onnxruntime.dll';

  const specs = [
    {
      id: 'esbuild-platform',
      candidates: [platform === 'win32'
        ? `@esbuild/${esbuildPackage}/esbuild.exe`
        : `@esbuild/${esbuildPackage}/bin/esbuild`],
    },
    { id: 'esbuild-launcher', candidates: ['esbuild/bin/esbuild'] },
    {
      id: 'sqlite-vec',
      candidates: [
        `sqlite-vec/node_modules/${sqlitePackage}/${sqliteLib}`,
        `${sqlitePackage}/${sqliteLib}`,
      ],
    },
    {
      id: 'canvas',
      candidates: [
        `@napi-rs/canvas/node_modules/@napi-rs/${canvasPackage}/${canvasLib}`,
        `@napi-rs/${canvasPackage}/${canvasLib}`,
      ],
    },
    {
      id: 'tokenizers',
      candidates: [
        `@anush008/tokenizers/node_modules/@anush008/${tokenizersPackage}/${tokenizersLib}`,
        `@anush008/${tokenizersPackage}/${tokenizersLib}`,
      ],
    },
    { id: 'better-sqlite3', candidates: ['better-sqlite3/build/Release/better_sqlite3.node'] },
    { id: 'onnxruntime-binding', candidates: [joinRelative(onnxBase, 'onnxruntime_binding.node')] },
    {
      id: 'onnxruntime-core',
      candidates: [joinRelative(onnxBase, onnxCoreLib)],
    },
    ...sharpNativeContract(platform, arch),
  ];

  if (linux) {
    for (const [optId, optName] of [
      ['onnxruntime-soname', 'libonnxruntime.so.1'],
      ['onnxruntime-providers-shared', 'libonnxruntime_providers_shared.so'],
    ]) {
      const rel = joinRelative(onnxBase, optName);
      if (isFile(path.join(nodeModules, ...rel.split('/')))) {
        specs.push({ id: optId, candidates: [rel] });
      }
    }
  }

  if (mac) {
    specs.push({ id: 'fsevents', candidates: ['fsevents/fsevents.node'] });
  }
  return specs;
}

function isNativePayloadFile(name) {
  return name === 'esbuild'
    || name === 'esbuild.exe'
    || /\.node$/i.test(name)
    || /\.dll$/i.test(name)
    || /\.dylib$/i.test(name)
    || /\.so(?:\.|$)/i.test(name);
}

function collectNativePayloadFiles(root, current = root, out = []) {
  if (!fs.existsSync(current)) return out;
  for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
    const absolute = path.join(current, entry.name);
    if (entry.isDirectory()) {
      collectNativePayloadFiles(root, absolute, out);
    } else if (entry.isFile() && isNativePayloadFile(entry.name)) {
      out.push(slash(path.relative(root, absolute)));
    }
  }
  return out;
}

function requiredNativeVerificationEntries(platform, arch) {
  const key = targetKey(platform, arch);
  if (!TARGETS.has(key)) {
    throw new Error(`[native-package-gate] unsupported packaged native target: ${key}`);
  }
  const ids = [
    'esbuild-platform',
    'esbuild-launcher',
    'sqlite-vec',
    'canvas',
    'tokenizers',
    'better-sqlite3',
    'onnxruntime-binding',
    'onnxruntime-core',
    'sharp-binding',
    'sharp-libvips-cpp',
    ...(platform === 'win32' ? ['sharp-libvips'] : []),
    ...(platform === 'darwin' ? ['fsevents'] : []),
  ];
  return ids.map((id) => `native:${id}:${key}`);
}

function verifyNativePackagePayload(nodeModules, platform, arch, options = {}) {
  if (!fs.existsSync(nodeModules) || !fs.statSync(nodeModules).isDirectory()) {
    throw new Error(`[native-package-gate] missing packaged node_modules: ${nodeModules}`);
  }
  const key = targetKey(platform, arch);
  const declared = new Set();
  const verified = [];
  for (const spec of nativePackageContract(nodeModules, platform, arch)) {
    const relativePath = firstExistingFile(nodeModules, spec.id, spec.candidates);
    const absolute = path.join(nodeModules, ...relativePath.split('/'));
    assertExecutableArch(absolute, platform, arch, options);
    declared.add(relativePath);
    verified.push(`native:${spec.id}:${key}`);
  }

  const actual = collectNativePayloadFiles(nodeModules).sort();
  const unexpected = actual.filter((relativePath) => !declared.has(relativePath));
  if (unexpected.length > 0) {
    throw new Error('[native-package-gate] unregistered native package payload(s): '
      + `${unexpected.join(', ')}. Register each real runtime dependency in native-package-gate.cjs.`);
  }

  const missingResults = requiredNativeVerificationEntries(platform, arch)
    .filter((entry) => !verified.includes(entry));
  if (missingResults.length > 0) {
    throw new Error(`[native-package-gate] verifier has no result for: ${missingResults.join(', ')}`);
  }
  return verified;
}

module.exports = {
  TARGETS,
  collectNativePayloadFiles,
  nativePackageContract,
  sharpNativeContract,
  sharpPreparationFiles,
  isNativePayloadFile,
  requiredNativeVerificationEntries,
  targetKey,
  verifyNativePackagePayload,
};
