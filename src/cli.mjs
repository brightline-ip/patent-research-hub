// Entry point of Hub.cmd and `node src/cli.mjs`. `gateway` is a separate, minimal path: it must not open the Hub store or
// parse the administrative flags (see gateway-cli.mjs). Everything else is the original command line in cli-main.mjs.
if(process.argv[2]==='gateway')await import('./gateway-cli.mjs');
else await import('./cli-main.mjs');
