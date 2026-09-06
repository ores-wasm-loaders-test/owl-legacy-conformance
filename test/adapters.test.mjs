import { test } from 'node:test';
import assert from 'node:assert/strict';
import { conformanceSuite, formatResults, createCoordinator } from '../index.mjs';
import { resolvePackage, resolveFile } from '../resolve.mjs';

const interfaces = await import(resolvePackage('owl-interfaces', 'ores-wasm-loaders'));
const { createLeptosAdapter, createDioxusAdapter } = await import(resolvePackage('owl-rust-loader', 'ores-wasm-loaders'));
const { createFlutterAdapter } = await import(resolvePackage('owl-flutter-loader', 'ores-wasm-loaders'));
const { manifests, testEnv, fakeDocument } = await import(resolveFile('owl-fixtures', 'ores-wasm-loaders-test', 'testkit.mjs'));

const validate = (m) => interfaces.checkManifest(m, interfaces.manifestSchema);

function glue() {
  return {
    async default() {},
    hydrate_islands() {},
    mount_route() {},
    main() {},
  };
}

function flutterGlobal() {
  const appRunner = {
    async addView() {
      return 1;
    },
    async removeView() {},
  };
  return {
    _flutter: {
      loader: {
        async load({ onEntrypointLoaded }) {
          await onEntrypointLoaded({
            async initializeEngine() {
              return { async runApp() { return appRunner; } };
            },
          });
        },
      },
    },
  };
}

const subjects = [
  {
    framework: 'leptos',
    manifest: manifests.leptos,
    adapter: () => createLeptosAdapter({ interfaces, importModule: async () => glue() }),
    activateOptions: {},
  },
  {
    framework: 'dioxus',
    manifest: manifests.dioxus,
    adapter: () => createDioxusAdapter({ interfaces, importModule: async () => glue() }),
    activateOptions: { host: { id: 'dioxus-root' }, route: '/app' },
  },
  {
    framework: 'flutter',
    manifest: manifests.flutter,
    adapter: () => createFlutterAdapter({ interfaces, global: flutterGlobal(), supportsWasmGc: () => true, loadScript: async () => {} }),
    activateOptions: { host: { id: 'app-view' } },
  },
];

for (const subject of subjects) {
  test(`conformance: ${subject.framework}`, async () => {
    const adapter = subject.adapter();
    const results = await conformanceSuite({
      adapter,
      manifest: subject.manifest,
      interfaces,
      activateOptions: subject.activateOptions,
      makeCoordinator: () => {
        const coordinator = createCoordinator({
          env: testEnv({ document: fakeDocument() }),
          validate,
          adapters: [subject.adapter()],
        });
        coordinator.register(subject.manifest);
        return coordinator;
      },
    });
    const failed = results.filter((r) => !r.ok);
    assert.deepEqual(failed, [], formatResults(subject.framework, results));
    assert.equal(results.length, 5);
  });
}

test('the suite fails an adapter that quietly starts a second application', async () => {
  let instances = 0;
  const rogue = {
    framework: 'leptos',
    supports: ['fetch'],
    plan: (m) => interfaces.preparableAssets(m),
    // Ignores the coordinator's instance cache by returning a fresh object every time AND
    // forcing re-activation — the shape of a real bug we want caught.
    async activate() {
      instances += 1;
      return { instances };
    },
  };
  const results = await conformanceSuite({
    adapter: rogue,
    manifest: manifests.leptos,
    interfaces,
    makeCoordinator: () => {
      const coordinator = createCoordinator({ env: testEnv({ document: fakeDocument() }), validate, adapters: [rogue] });
      coordinator.register(manifests.leptos);
      const original = coordinator.activate.bind(coordinator);
      coordinator.activate = (appId, options) => original(appId, { ...options, force: true });
      return coordinator;
    },
  });
  const idempotency = results.find((r) => r.name.includes('second activation'));
  assert.equal(idempotency.ok, false, formatResults('rogue', results));
});
