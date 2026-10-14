// The CLI entry (dist/cli/index.js, the package `bin`): runs main() on the real argv and
// process. A thin entry; the dispatch is in main.ts (ADR 063).
import { main } from './main';

await main(process.argv);
