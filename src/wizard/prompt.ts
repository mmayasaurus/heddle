import { createInterface } from 'node:readline/promises';
import { stdin, stderr } from 'node:process';

export interface Prompter {
  text(question: string, defaultValue?: string): Promise<string>;
  select(question: string, choices: readonly string[]): Promise<string>;
  confirm(question: string, defaultValue?: boolean): Promise<boolean>;
  secret(question: string): Promise<string>;
  /** Release any held terminal handle so the process event loop can drain. */
  close(): void;
}

export class ReadlinePrompter implements Prompter {
  private readonly terminal = createInterface({ input: stdin, output: stderr });

  async text(question: string, defaultValue?: string): Promise<string> {
    const value = await this.terminal.question(`${question}${defaultValue ? ` [${defaultValue}]` : ''}: `);
    return value || defaultValue || '';
  }

  async select(question: string, choices: readonly string[]): Promise<string> {
    stderr.write(`${question}\n${choices.map((choice, index) => `  ${index + 1}) ${choice}`).join('\n')}\n`);
    const value = await this.terminal.question('Choose: ');
    const index = Number(value) - 1;
    return choices[index] ?? choices[0] ?? '';
  }

  async confirm(question: string, defaultValue = false): Promise<boolean> {
    const value = await this.terminal.question(`${question} ${defaultValue ? '[Y/n]' : '[y/N]'}: `);
    return value ? /^y(es)?$/i.test(value) : defaultValue;
  }

  async secret(question: string): Promise<string> {
    // Raw mode prevents the terminal driver from echoing each character.
    // TODO(HED-503): this raw `data` listener conflicts with the live readline interface on stdin
    // (readline also consumes/echoes bytes). PR-A never calls secret(); before the PR-B key-entry
    // providers use it, pause or close `this.terminal` around the raw read.
    if (!stdin.isTTY) throw new Error('secret input requires a TTY');
    stderr.write(`${question}: `);
    stdin.setRawMode(true);
    stdin.resume();
    return new Promise((resolve) => {
      let value = '';
      const onData = (chunk: Buffer) => {
        for (const byte of chunk) {
          if (byte === 13 || byte === 10) {
            stdin.off('data', onData); stdin.setRawMode(false); stderr.write('\n'); resolve(value); return;
          }
          if (byte === 3) { stdin.off('data', onData); stdin.setRawMode(false); resolve(''); return; }
          if (byte === 127 || byte === 8) { value = value.slice(0, -1); continue; }
          value += String.fromCharCode(byte);
        }
      };
      stdin.on('data', onData);
    });
  }

  close(): void {
    this.terminal.close();
  }
}

export class ScriptedPrompter implements Prompter {
  constructor(private readonly answers: unknown[]) {}

  private next(): unknown {
    if (!this.answers.length) throw new Error('answer script exhausted');
    return this.answers.shift();
  }

  async text(_question: string, defaultValue?: string): Promise<string> {
    const answer = this.next();
    return answer === '' || answer === undefined ? defaultValue ?? '' : String(answer);
  }

  async select(_question: string, choices: readonly string[]): Promise<string> {
    const answer = String(this.next());
    if (!choices.includes(answer)) throw new Error(`invalid scripted choice: ${answer}`);
    return answer;
  }

  async confirm(_question: string, _defaultValue = false): Promise<boolean> {
    const answer = this.next();
    if (typeof answer !== 'boolean') throw new Error('scripted confirmation must be boolean');
    return answer;
  }

  async secret(_question: string): Promise<string> { return String(this.next()); }

  close(): void { /* no readline handle to release */ }
}
