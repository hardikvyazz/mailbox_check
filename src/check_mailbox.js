const fs = require('fs');
const dns = require('dns').promises;
const net = require('net');
const csv = require('csv-parser');

const INPUT_FILE = 'email.csv';
const OUTPUT_FILE = 'emails_report.csv';
const FROM_EMAIL = 'test@example.com';

const results = [];

function getMX(domain) {
  return dns.resolveMx(domain).then(mx =>
    mx.sort((a, b) => a.priority - b.priority)
  ).catch(() => []);
}

function smtpProbe(mxHost, toEmail) {
  return new Promise((resolve) => {
    const socket = net.createConnection(25, mxHost);
    let step = 0;

    socket.setEncoding('utf-8');
    socket.setTimeout(5000);

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
        } else if (/552/.test(data)) {
          resolve({ status: 'Mailbox Full', log: responseLog });
        } 
        else if (/452/.test(data) || /554/.test(data)) {
            resolve({ status: 'Mailbox Full', log: responseLog });
        }
        else if (/550/.test(data)) {
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
      resolve({ status: 'Connection Failed 💥', log: responseLog });
    });
  });
}

function writeReport() {
  const header = 'email,status\n';
  const rows = results.map(r => `${r.email},${r.status}`).join('\n');
  fs.writeFileSync(OUTPUT_FILE, header + rows);
  console.log(`✅ Report written to ${OUTPUT_FILE}`);
}

async function processEmails() {
  const emails = [];
  fs.createReadStream(INPUT_FILE)
    .pipe(csv())
    .on('data', (row) => emails.push(row.email))
    .on('end', async () => {
      for (const email of emails) {
        const domain = email.split('@')[1];
        if (domain !== 'gmail.com') {
          results.push({ email, status: '' });
          continue;
        }

        console.log(`🔍 Checking: ${email}`);
        const mxRecords = await getMX(domain);
        if (!mxRecords.length) {
          results.push({ email, status: 'No MX Records ❌' });
          continue;
        }

        const mxHost = mxRecords[0].exchange;
        const { status, log } = await smtpProbe(mxHost, email);
        console.log(`📬 ${email}: ${status}`);
        results.push({ email, status });

        // Optional: Log the SMTP conversation if needed
        // fs.writeFileSync(`${email.replace(/[@.]/g, '_')}_log.txt`, log.join('\n'));
      }
      writeReport();
    });
}

processEmails();
