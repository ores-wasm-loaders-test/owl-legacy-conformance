// owl-conformance — what it means to BE a loader adapter in this fleet.
//
// A product org should be able to write its own adapter (a framework we do not ship, an
// in-house renderer) and know it will behave like the others. Conformance is defined by the
// lifecycle contract in owl-interfaces, not by any particular framework version, so this
// suite asks only contract questions:
//
//   * does `plan` describe preparable work, in the interfaces' order, excluding lazy assets?
//   * does preparation stay within the capabilities it is given, and touch nothing else?
//   * does activation work when preparation never happened?
//   * is a second activation the same instance rather than a second application?
//   * does the adapter refuse a release it cannot honestly serve?
//
// It runs against the fixtures in this org, on this org's Actions minutes.

import { resolvePackage } from './resolve.mjs';

const { createCoordinator } = await import(resolvePackage('owl-coordinator', 'ores-wasm-loaders'));

const CASES = [
  {
    name: 'plan describes preparable work in the interfaces order',
    async run({ adapter, manifest, interfaces }) {
      const planned = adapter.plan(manifest);
      const expected = interfaces.preparableAssets(manifest);
      if (!planned.length) throw new Error('plan() returned nothing');
      for (const item of planned) {
        if (!expected.some((e) => e.path === item.path)) {
          throw new Error(`plan() includes \`${item.path}\`, which owl-interfaces does not consider preparable`);
        }
        if (item.stage === 'lazy') throw new Error(`plan() includes the lazy asset \`${item.path}\``);
      }
      const order = planned.map((p) => expected.findIndex((e) => e.path === p.path));
      if (order.some((v, i) => i > 0 && v < order[i - 1])) throw new Error('plan() reorders the interfaces priority');
      return `${planned.length} item(s)`;
    },
  },
  {
    name: 'preparation uses only the capabilities it is handed',
    async run({ coordinator, manifest }) {
      const receipt = await coordinator.prepare(manifest.appId);
      if (receipt.releaseId !== manifest.releaseId) throw new Error('receipt names another release');
      if (receipt.bytes > manifest.prepare.maxBytes) throw new Error(`spent ${receipt.bytes} over a ${manifest.prepare.maxBytes} budget`);
      return `${receipt.prepared.length} prepared, ${receipt.bytes} bytes`;
    },
  },
  {
    name: 'activation succeeds with no preparation at all',
    async run({ freshCoordinator, manifest, activateOptions }) {
      const coordinator = freshCoordinator();
      const instance = await coordinator.activate(manifest.appId, activateOptions);
      if (!instance) throw new Error('activate() resolved to nothing');
      return 'cold entry works';
    },
  },
  {
    name: 'a second activation is the same instance, not a second application',
    async run({ freshCoordinator, manifest, activateOptions }) {
      const coordinator = freshCoordinator();
      const [a, b] = await Promise.all([
        coordinator.activate(manifest.appId, activateOptions),
        coordinator.activate(manifest.appId, activateOptions),
      ]);
      if (a !== b) throw new Error('concurrent activations produced different instances');
      const c = await coordinator.activate(manifest.appId, activateOptions);
      if (c !== a) throw new Error('a later activation produced a different instance');
      return 'idempotent';
    },
  },
  {
    name: 'a release the adapter cannot honestly serve is refused',
    async run({ freshCoordinator, manifest, activateOptions }) {
      const coordinator = freshCoordinator();
      const broken = { ...manifest, entrypoints: manifest.entrypoints.filter((e) => e.role !== 'module' && e.role !== 'bootstrap') };
      try {
        coordinator.registry.register(broken);
      } catch {
        return 'refused by the manifest contract before the adapter saw it';
      }
      try {
        await coordinator.activate(manifest.appId, activateOptions);
      } catch (error) {
        return `refused: ${error.message.slice(0, 60)}`;
      }
      throw new Error('a release missing its entry module activated anyway');
    },
  },
];

/**
 * Run the suite. `makeCoordinator()` must return a coordinator with this adapter registered
 * and the manifest already registered, so the suite stays framework-agnostic.
 */
export async function conformanceSuite({ adapter, manifest, interfaces, makeCoordinator, activateOptions = {} }) {
  const results = [];
  for (const testCase of CASES) {
    const coordinator = makeCoordinator();
    try {
      const detail = await testCase.run({
        adapter,
        manifest,
        interfaces,
        coordinator,
        freshCoordinator: makeCoordinator,
        activateOptions,
      });
      results.push({ name: testCase.name, ok: true, detail });
    } catch (error) {
      results.push({ name: testCase.name, ok: false, detail: error.message });
    }
  }
  return results;
}

export function formatResults(framework, results) {
  const failed = results.filter((r) => !r.ok);
  const lines = results.map((r) => `  ${r.ok ? 'ok  ' : 'FAIL'} ${r.name} — ${r.detail}`);
  return `[conformance] ${framework}: ${results.length - failed.length}/${results.length} passed\n${lines.join('\n')}`;
}

export { createCoordinator };
