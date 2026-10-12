// Runs the fake GitHub (standin.ts) as its own process for a scratch portal and for K2/K3: prints its URL, accepts control calls at
// /__standin/* (approve, deny, advance, token, state). Usage: `npx tsx src/codespaces/standin-cli.ts [--port N]`, then start the portal with
// PORTAL_GITHUB_STANDIN_URL=<url> and PORTAL_GITHUB_CLIENT_ID=Iv1.standin. One fine-grained stand-in token is preset; its value is printed:
// it is fake and only this process accepts it.
import { startGitHubStandIn } from './standin.js';

const at = process.argv.indexOf('--port');
const port = at > 0 ? Number(process.argv[at + 1]) || 0 : 0;
const gh = await startGitHubStandIn({ control: true, interval: 5, port });
const demo = 'github_pat_' + '11STANDIN0000000000000_fakefakefakefakefakefakefakefakefakefakefake';
gh.addToken(demo, { login: 'octocat', kind: 'fine-grained', permissions: ['codespaces:write', 'lifecycle:write', 'metadata:read'] });
console.log(JSON.stringify({ url: gh.url, clientId: 'Iv1.standin', demoToken: demo }));
