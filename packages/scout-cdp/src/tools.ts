import type { ExposedConnector, ExposedTool, ToolCallOutcome, ToolPort } from '@outcrawl/runtime';

/**
 * Combines any number of `ToolPort`s into one, or returns `undefined` when
 * none are live — the same "absent means this run reaches nothing outside
 * the browser" state `AgentDeps.tools` already documents, preserved exactly
 * for a run with neither connectors nor web tools.
 *
 * One port through unchanged (no wrapping, no extra `list()` round trip):
 * most runs have at most a connector port OR a web port, never both, and this
 * keeps that the zero-overhead case it always was.
 *
 * Two or more: `list()` is called on every live port exactly ONCE — cached
 * behind the first call, `list()` or `call()`, whichever the loop makes
 * first — and merged into one flat catalogue plus a name→port routing table,
 * so `call()` never has to guess which backend owns a name from its prefix.
 * `list()` itself is already called once per run by the loop
 * (`runtime/src/loop.ts`'s `toolCatalogue`), so this adds no extra network
 * round trip beyond what a bare connector port already pays.
 */
export function composeToolPorts(
  ...ports: ReadonlyArray<ToolPort | null | undefined>
): ToolPort | undefined {
  const active = ports.filter((port): port is ToolPort => port !== null && port !== undefined);
  if (active.length === 0) {
    return undefined;
  }
  if (active.length === 1) {
    return active[0];
  }

  interface Resolved {
    readonly all: readonly ExposedTool[];
    readonly services: readonly ExposedConnector[];
    readonly routes: ReadonlyMap<string, ToolPort>;
  }
  let cached: Resolved | undefined;
  const resolve = async (): Promise<Resolved> => {
    if (cached === undefined) {
      const perPort = await Promise.all(active.map(async (port) => [port, await port.list()] as const));
      const routes = new Map<string, ToolPort>();
      const all: ExposedTool[] = [];
      for (const [port, exposed] of perPort) {
        for (const tool of exposed) {
          routes.set(tool.name, port);
          all.push(tool);
        }
      }
      // After every `list`, because a port learns its services while listing.
      // Only a connector port has any; the built-in ports contribute none.
      const services = (
        await Promise.all(active.map(async (port) => (port.connectors === undefined ? [] : await port.connectors())))
      ).flat();
      cached = { all, services, routes };
    }
    return cached;
  };

  return {
    async list(): Promise<readonly ExposedTool[]> {
      return (await resolve()).all;
    },
    async connectors(): Promise<readonly ExposedConnector[]> {
      return (await resolve()).services;
    },
    // Every port's, asked per step and never cached: a port withdraws mid-run.
    withdrawn(): readonly string[] {
      return active.flatMap((port) => port.withdrawn?.() ?? []);
    },
    async call(tool, args): Promise<ToolCallOutcome> {
      const { routes } = await resolve();
      const port = routes.get(tool);
      if (port === undefined) {
        return {
          isError: true,
          text: `no connected tool is named "${tool}". Call one of the names listed above, exactly as spelled.`,
        };
      }
      return port.call(tool, args);
    },
  };
}
