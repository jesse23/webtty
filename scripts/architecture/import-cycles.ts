// Finds runtime import cycles among source files (util, ADR 059, ADR 061). Type-only
// and dynamic imports are left out: they are erased or load lazily, so they cannot
// leave a module half-initialised.

import { resolveImport, scanImports } from './import-scan';
import { isTestCode, type SourceFile, type Violation } from './source-file';

/** Each file's runtime imports of other files in the tree. */
export function runtimeImportGraph(files: readonly SourceFile[]): Map<string, string[]> {
  const known = new Set(files.map((file) => file.path));
  const graph = new Map<string, string[]>();
  for (const file of files) {
    if (isTestCode(file.path)) continue;
    const edges = new Set<string>();
    for (const ref of scanImports(file.text)) {
      if (ref.typeOnly || ref.dynamic) continue;
      const target = resolveImport(file.path, ref.specifier, known);
      if (target !== null && known.has(target) && !isTestCode(target)) edges.add(target);
    }
    graph.set(file.path, [...edges]);
  }
  return graph;
}

/**
 * The graph's strongly connected components with more than one file, or a file that
 * imports itself (Tarjan's algorithm), each sorted by path.
 */
export function findCycles(graph: ReadonlyMap<string, readonly string[]>): string[][] {
  const index = new Map<string, number>();
  const low = new Map<string, number>();
  const stack: string[] = [];
  const onStack = new Set<string>();
  const cycles: string[][] = [];

  const visit = (node: string): void => {
    index.set(node, index.size);
    low.set(node, index.get(node) as number);
    stack.push(node);
    onStack.add(node);
    for (const next of graph.get(node) ?? []) {
      if (!index.has(next)) {
        visit(next);
        low.set(node, Math.min(low.get(node) as number, low.get(next) as number));
      } else if (onStack.has(next)) {
        low.set(node, Math.min(low.get(node) as number, index.get(next) as number));
      }
    }
    if (low.get(node) !== index.get(node)) return;
    const component: string[] = [];
    let member: string;
    do {
      member = stack.pop() as string;
      onStack.delete(member);
      component.push(member);
    } while (member !== node);
    if (component.length > 1 || graph.get(node)?.includes(node)) cycles.push(component.sort());
  };

  for (const node of graph.keys()) if (!index.has(node)) visit(node);
  return cycles;
}

/** One violation per runtime import cycle, keyed by its sorted members. */
export function checkCycles(files: readonly SourceFile[]): Violation[] {
  return findCycles(runtimeImportGraph(files)).map((members) => ({
    rule: 'cycle',
    file: members[0],
    key: `cycle ${members.join(' ')}`,
    message: `runtime import cycle: ${members.join(' → ')}`,
  }));
}
