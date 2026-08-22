/**
 * Process entry. Deliberately imports almost nothing at module load: the
 * config bootstrap must hydrate stored settings/secrets into `process.env`
 * BEFORE any module that reads env-derived constants is evaluated, so the
 * server is only imported dynamically afterwards.
 */
import { bootstrapConfig } from "../config/bootstrap.ts";
import { setDataDir } from "../config/data-dir.ts";

function printHelp(): void {
  console.log(`
  Model-Proxy v2

  Usage:
    model-proxy [start]          Start the proxy server
    model-proxy --help           Show this help

  Options:
    --host <addr>               Listen address (default: 127.0.0.1)
    --port <num>                Listen port (default: 9876)
    --data-dir <path>           Data directory (default: ~/.model-proxy)
    --log-level <level>         debug | info | warn | error
  `);
}

const argv = process.argv.slice(2);
if (argv.includes("--help") || argv.includes("-h")) {
  printHelp();
} else {
  const dataDirIdx = argv.indexOf("--data-dir");
  if (dataDirIdx !== -1) {
    const value = argv[dataDirIdx + 1];
    if (value !== undefined && !value.startsWith("--")) setDataDir(value);
  }

  bootstrapConfig();

  const { serve } = await import("./serve.ts");
  serve(argv);
}
