(async () => {
  const fs = require('fs');
  const dns = require('dns').promises;
  const net = require('net');
  const csv = require('csv-parser');
  const path = require('path');
  const { default: pLimit } = await import('p-limit');
  const readline = require('readline');

  const INPUT_FILE = '../data/email.csv';
  const inputBaseName = path.basename(INPUT_FILE); // => 'notify_nop_May05.csv'
  const { name: fileNameWithoutExt, ext } = path.parse(inputBaseName);
  const OUTPUT_FILE = `${fileNameWithoutExt}_mailbox_report${ext}`;

  const FROM_EMAIL = 'test@example.com';
  const CONCURRENCY_LIMIT = 10;

  const results = [];
  const mxCache = {};
  const limit = pLimit(CONCURRENCY_LIMIT);

  async function getCachedMX(domain) {
    if (mxCache[domain]) return mxCache[domain];
    const mx = await getMX(domain);
    mxCache[domain] = mx;
    return mx;
  }

  function getMX(domain) {
    return dns.resolveMx(domain)
      .then(mx => mx.sort((a, b) => a.priority - b.priority))
      .catch(() => []);
  }

  function smtpProbe(mxHost, toEmail) {
    return new Promise((resolve) => {
      const socket = net.createConnection(25, mxHost);
      let step = 0;
      socket.setEncoding('utf-8');
      socket.setTimeout(10000);

      let responseLog = [];

      socket.on('data', data => {
        responseLog.push(data.trim());

        if (step === 0 && /^220/.test(data)) {
          socket.write(`HELO checkme.com\r\n`);
          step++;
        } else if (step === 1 && /^250/.test(data)) {
          socket.write(`MAIL FROM:<${FROM_EMAIL}>\r\n`);
          step++;
        } else if (step === 2 && /^250/.test(data)) {
          socket.write(`RCPT TO:<${toEmail}>\r\n`);
          step++;
        } else if (step === 3) {
          if (/250/.test(data)) {
            resolve({ status: 'Valid Inbox', log: responseLog });
          } else if (/552|452|554/.test(data)) {
            resolve({ status: 'Mailbox Full', log: responseLog });
          } else if (/550/.test(data)) {
            resolve({ status: 'Invalid', log: responseLog });
          } else {
            resolve({ status: 'Ambiguous', log: responseLog });
          }
          socket.end();
        }
      });

      socket.on('timeout', () => {
        socket.destroy();
        resolve({ status: 'Timeout ⌛', log: responseLog });
      });

      socket.on('error', () => {
        resolve({ status: 'Connection Failed', log: responseLog });
      });
    });
  }


  function writeReport() {
    const header = 'email,status\n';
    const rows = results.map(r => `${r.email},${r.status}`).join('\n');
    fs.appendFileSync(OUTPUT_FILE, header + rows);
    // console.log(`✅ Report written to ${OUTPUT_FILE}`);
  }

  let lastLine = -1;
  async function readInputFile() {
    const inputStream = fs.createReadStream(INPUT_FILE);
    const rl = readline.createInterface({
      input: inputStream,
      crlfDelay: Infinity,
    });

  const lines = [];
  let startLine = lastLine + 1;
  const endLine = startLine + 10;
  lastLine = endLine;

  let currentLine = 0;
  const startFrom = 0; // Start reading from line 1000

  for await (const line of rl) {
  currentLine++;
  if (currentLine < startFrom) continue;
  lines.push(line);
}
  return lines; 
  }

  async function validateEmail(email) {

    if (!email || !email.includes('@')) {
      return { email, status: 'Invalid Format' };
    }

    const domain = email.split('@')[1];
    if (domain !== 'gmail.com') {
      return { email, status: '' };
    }

    // console.log(`🔍 Checking: ${email}`);
    const mxRecords = await getCachedMX(domain);
    if (!mxRecords.length) {
      return { email, status: 'No MX Records' };
    }

    const mxHost = mxRecords[0].exchange;
    const { status } = await smtpProbe(mxHost, email);
    console.log(`${email},${status}`);
    
    return { email, status };

  }

  async function init() {

    while (true) {
      const emails = await readInputFile();
      if(emails.length === 0) {
        console.log('No more lines to read.');
        break;
      }

      let batch = [];
      for (let i = 0; i < emails.length; i++) {

        batch.push(validateEmail(emails[i]));
        if (batch.length === 10) {
          const resultsBatch = await Promise.all(batch);
          results.push(...resultsBatch);
          batch = [];
        }
      }

      // Save processed 1000 emails to the report file
      if (results.length > 0) {
        writeReport();
        console.log(`Processed ${results.length} emails.`);
      }
    }
  }

  await init();
})();
