declare module '@lydell/node-pty' {
  interface IPty {
    onData(cb: (data: string) => void): void;
    onExit(cb: (e: { exitCode: number; signal?: number }) => void): void;
    write(data: string): void;
    resize(cols: number, rows: number): void;
    kill(signal?: string): void;
  }

  interface ISpawnOptions {
    name?: string;
    cols?: number;
    rows?: number;
    cwd?: string;
    env?: Record<string, string | undefined>;
  }

  function spawn(file: string, args: string[], options: ISpawnOptions): IPty;

  export default { spawn };
}
