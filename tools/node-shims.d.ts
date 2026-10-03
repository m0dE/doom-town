// The few Node APIs the tsx-run tools use, so `tsc` checks them without @types/node.
declare module 'node:fs' {
  export function readFileSync(path: string): Uint8Array;
}
declare module 'node:path' {
  const path: { resolve(...p: string[]): string; dirname(p: string): string; join(...p: string[]): string };
  export default path;
}
declare const process: { argv: string[]; exit(code?: number): never; env: Record<string, string | undefined> };
