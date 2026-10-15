import readline from 'node:readline';
import { hashPassword } from '../auth/password.js';

/**
 * Prints a DJ_PASSWORD_HASH value. The password is read from a hidden prompt (or stdin when
 * piped) so it never appears in shell history or process arguments.
 */
function promptHidden(question: string): Promise<string> {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    const rlAny = rl as unknown as { _writeToOutput: (s: string) => void; output: NodeJS.WriteStream };
    let muted = false;
    rlAny._writeToOutput = (s: string) => {
      if (!muted) rlAny.output.write(s);
    };
    rl.question(question, (answer) => {
      rl.close();
      process.stdout.write('\n');
      resolve(answer);
    });
    muted = true;
  });
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8').split(/\r?\n/)[0] ?? '';
}

const password = process.stdin.isTTY ? await promptHidden('DJ password (hidden): ') : await readStdin();

if (password.length < 8) {
  console.error('Password must be at least 8 characters.');
  process.exit(1);
}

const hash = await hashPassword(password);
console.log('\nAdd this to your environment (do not commit it):\n');
console.log(`DJ_PASSWORD_HASH=${hash}`);
