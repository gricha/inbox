const HOME = "/Users/you";
export const homedir = (): string => HOME;
export const tmpdir = (): string => "/tmp";
export const platform = (): string => "darwin";
export const hostname = (): string => "your-mac";
export default { homedir, tmpdir, platform, hostname, EOL: "\n" };
