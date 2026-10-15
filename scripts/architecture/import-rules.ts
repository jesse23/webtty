// The SPEC's import rules, one entry per rule in a table, checked against every import
// in the tree (util, ADR 059; the rules are in docs/specs/architecture.md).

import {
  type ImportRef,
  isNodeBuiltin,
  isRelative,
  resolveImport,
  scanImports,
} from './import-scan';
import {
  isTestCode,
  isTestFile,
  type Layer,
  layerOf,
  type RuleId,
  type SourceFile,
  VENDOR_BARREL,
  VENDOR_ROOT,
  type Violation,
} from './source-file';

/** What a rule sees of one import: who imports, the import, and where it points. */
export interface ImportSite {
  from: string;
  ref: ImportRef;
  /** The resolved repo path for a relative import, else the specifier itself. */
  target: string;
}

interface ImportRule {
  id: RuleId;
  /** Test code is exempt from every rule but the test-import one (contract tests). */
  appliesToTests: boolean;
  /** A message when the import breaks the rule, else null. */
  broken(site: ImportSite): string | null;
}

/**
 * The facades a split vendor part must not import, even as a type: a part sees the narrow
 * interfaces, so it never depends on a facade class and no runtime cycle can form (ADR 061).
 */
export const VENDOR_FACADES = new Set(
  ['ghostty.ts', 'terminal.ts', 'renderer.ts', 'input-handler.ts', 'selection-manager.ts'].map(
    (name) => `${VENDOR_ROOT}${name}`,
  ),
);

const VENDOR_PART_RE = /^src\/client\/vendor\/ghostty-web\/(engine|core|render|input|selection)\//;
const FEATURE_RE = /^src\/client\/features\/([^/]+)\//;
// The client layers features build on; only the composition root sits above features.
const BELOW_FEATURES_RE = /^src\/client\/(app|connection|layout)\//;
const COMPOSITION_ROOT = 'src/client/app/start-client.ts';
const BROWSER_SIDE: Layer[] = ['client', 'vendor'];
const NODE_SIDE: Layer[] = ['server', 'cli', 'pty', 'config'];

function isBrowserSide(file: string): boolean {
  return BROWSER_SIDE.includes(layerOf(file));
}

/** The import rules, in the order the SPEC lists them. */
export const IMPORT_RULES: ImportRule[] = [
  {
    id: 'client-node',
    appliesToTests: false,
    broken: ({ from, ref }) =>
      isBrowserSide(from) && isNodeBuiltin(ref.specifier)
        ? `imports the Node module '${ref.specifier}'`
        : null,
  },
  {
    id: 'client-server',
    appliesToTests: false,
    broken: ({ from, ref, target }) =>
      isBrowserSide(from) &&
      isRelative(ref.specifier) &&
      ['server', 'cli', 'pty'].includes(layerOf(target))
        ? `imports ${target}; the client imports nothing from the server, CLI or PTY`
        : null,
  },
  {
    id: 'client-config-value',
    appliesToTests: false,
    broken: ({ from, ref, target }) =>
      isBrowserSide(from) &&
      isRelative(ref.specifier) &&
      layerOf(target) === 'config' &&
      !ref.typeOnly
        ? `imports ${target} as a value; the client takes config types only (import type)`
        : null,
  },
  {
    id: 'server-client',
    appliesToTests: false,
    broken: ({ from, ref, target }) =>
      NODE_SIDE.includes(layerOf(from)) && isRelative(ref.specifier) && isBrowserSide(target)
        ? `imports the client file ${target}`
        : null,
  },
  {
    id: 'cli-server',
    appliesToTests: false,
    broken: ({ from, ref, target }) =>
      layerOf(from) === 'cli' && isRelative(ref.specifier) && layerOf(target) === 'server'
        ? `imports ${target}; the CLI starts the server as a process`
        : null,
  },
  {
    id: 'vendor-outside',
    appliesToTests: false,
    broken: ({ from, ref, target }) => {
      if (layerOf(from) !== 'vendor' || isNodeBuiltin(ref.specifier)) return null;
      if (isRelative(ref.specifier) && target.startsWith(VENDOR_ROOT)) return null;
      return `imports ${target} from outside the vendored ghostty-web tree`;
    },
  },
  {
    id: 'vendor-deep',
    appliesToTests: false,
    broken: ({ from, ref, target }) =>
      layerOf(from) === 'client' &&
      isRelative(ref.specifier) &&
      target.startsWith('src/client/vendor/') &&
      target !== VENDOR_BARREL
        ? `imports ${target}; app code imports vendor code through the barrel only`
        : null,
  },
  {
    id: 'feature-feature',
    appliesToTests: false,
    broken: ({ from, target }) => {
      const own = FEATURE_RE.exec(from)?.[1];
      const other = FEATURE_RE.exec(target)?.[1];
      return own && other && own !== other ? `feature '${own}' imports feature '${other}'` : null;
    },
  },
  {
    id: 'below-feature',
    appliesToTests: false,
    broken: ({ from, target }) =>
      BELOW_FEATURES_RE.test(from) && from !== COMPOSITION_ROOT && FEATURE_RE.test(target)
        ? `imports ${target}; app/, connection/ and layout/ sit below the features`
        : null,
  },
  {
    id: 'facade-import',
    appliesToTests: false,
    broken: ({ from, target }) =>
      VENDOR_PART_RE.test(from) && VENDOR_FACADES.has(target)
        ? `imports the facade ${target}; split parts import the narrow interfaces`
        : null,
  },
  {
    id: 'test-import',
    appliesToTests: true,
    broken: ({ target }) =>
      isTestFile(target) || target.endsWith('.test')
        ? `imports the test file ${target}; shared test code lives in test-support/`
        : null,
  },
];

/** Every import that breaks an import rule, keyed `<rule> <file> -> <target>`. */
export function checkImports(files: readonly SourceFile[]): Violation[] {
  const known = new Set(files.map((file) => file.path));
  const violations: Violation[] = [];
  for (const file of files) {
    const testCode = isTestCode(file.path);
    for (const ref of scanImports(file.text)) {
      const target = resolveImport(file.path, ref.specifier, known) ?? ref.specifier;
      const site = { from: file.path, ref, target };
      for (const rule of IMPORT_RULES) {
        if (testCode && !rule.appliesToTests) continue;
        const message = rule.broken(site);
        if (message === null) continue;
        violations.push({
          rule: rule.id,
          file: file.path,
          key: `${rule.id} ${file.path} -> ${target}`,
          message: `${file.path}:${ref.line} ${message}`,
        });
      }
    }
  }
  return violations;
}
