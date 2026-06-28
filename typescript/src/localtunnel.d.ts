// Type declarations for localtunnel (optional --tunnel dependency).
// localtunnel is not a hard dependency of @thumbrella/client — it is only
// imported dynamically when the user passes the --tunnel flag.  These
// declarations let TypeScript check the usage at build time without
// requiring the package to be installed.
declare module "localtunnel" {
  interface Tunnel {
    url: string;
    close(): void;
  }

  interface TunnelOptions {
    port: number;
    host?: string;
    subdomain?: string;
    local_host?: string;
  }

  function localtunnel(options: TunnelOptions): Promise<Tunnel>;

  export default localtunnel;
}
