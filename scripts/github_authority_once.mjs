import { pathToFileURL } from "node:url";
import { createGitHubAuthorityAdapter } from "../src/github_authority_adapter.mjs";
import { runOnce } from "../src/github_authority_resident.mjs";

// Explicit invocation only. No token is read and no network request is made on import.
export async function main(argv = process.argv.slice(2), env = process.env) {
  if (argv.length !== 4 || argv[0] !== "--resident-instance-id" || argv[2] !== "--trigger-contract-hash" || !argv[1] || !argv[3]) throw new Error("USAGE: --resident-instance-id ID --trigger-contract-hash HASH");
  const github = createGitHubAuthorityAdapter({ token: env.GITHUB_TOKEN });
  return runOnce({ github, residentInstanceId: argv[1], triggerContractHash: argv[3], now: new Date().toISOString() });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then(result => {
    process.stdout.write(`${JSON.stringify(result)}\n`);
  }).catch(error => {
    process.stderr.write(`${error?.message || "GITHUB_AUTHORITY_ONCE_FAILED"}\n`);
    process.exitCode = 1;
  });
}
