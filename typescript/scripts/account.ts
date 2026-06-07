import { config } from 'dotenv';
import { parseConnectionString, ThumbrellaClient } from '../src/index.ts';

declare const process: {
  env: Record<string, string | undefined>;
  argv: string[];
  exit(code?: number): never;
};

config({ path: '.dev.env' });

function resolveConnectionString(): string {
  const connect = process.env.TBR_CONNECT?.trim();
  if (connect) {
    return connect;
  }

  const legacyConnection = process.env.THUMBRELLA_API_KEY?.trim();
  if (legacyConnection) {
    return legacyConnection;
  }

  throw new Error([
    'No connection configuration found.',
    'Set one of these in .dev.env:',
    '  TBR_CONNECT=<api_key | http://host | https://host,api_key>',
  ].join('\n'));
}

function hasFlag(flag: string): boolean {
  return process.argv.includes(flag);
}

async function main(): Promise<void> {
  const connection = resolveConnectionString();
  const client = new ThumbrellaClient(connection);
  const configView = parseConnectionString(connection);

  console.log(`Using server: ${configView.baseUrl}`);
  console.log(`Auth key: ${configView.apiKey ? 'present' : 'not set'}`);

  const account = await client.getAccount();
  if (hasFlag('--raw')) {
    console.log(JSON.stringify(account, null, 2));
    return;
  }

  const accountId = account.id || (typeof account.raw.account_id === 'string' ? account.raw.account_id : 'unknown');
  console.log(`Connected. Account id: ${accountId}`);
  if (account.token_type) {
    console.log(`Token type: ${account.token_type}`);
  }
  console.log('Use --raw for full account payload.');
}

main().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  console.error(`Error: ${message}`);
  process.exit(1);
});
