let pipedLines;

async function readPipedLine() {
  if (!pipedLines) {
    const chunks = [];
    for await (const chunk of process.stdin) chunks.push(chunk);
    pipedLines = Buffer.concat(chunks).toString('utf8').split(/\r?\n/);
  }
  return pipedLines.shift() ?? '';
}

// Reads a line without echoing it.
export function promptHidden(question) {
  const { stdin, stdout } = process;
  stdout.write(question);
  if (!stdin.isTTY) return readPipedLine().then((line) => (stdout.write('\n'), line));

  return new Promise((resolve) => {
    let value = '';
    const finish = () => {
      stdin.off('data', onData);
      stdin.setRawMode(false);
      stdin.pause();
      stdout.write('\n');
    };
    const onData = (chunk) => {
      if (chunk === '\u001b') return finish(), process.exit(0);
      for (const ch of chunk) {
        if (ch === '\r' || ch === '\n') return finish(), resolve(value);
        if (ch === '\u0003') return finish(), process.exit(130);
        if (ch === '\u007f' || ch === '\b') value = value.slice(0, -1);
        else if (ch >= ' ') value += ch;
      }
    };
    stdin.setRawMode(true);
    stdin.setEncoding('utf8');
    stdin.resume();
    stdin.on('data', onData);
  });
}
