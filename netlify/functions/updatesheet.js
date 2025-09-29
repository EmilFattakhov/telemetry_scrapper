import { google } from 'googleapis';
import puppeteer from 'puppeteer-core';
import chromium from '@sparticuz/chromium';
import { activate } from '@autonomys/auto-utils';
import { spacePledged } from '@autonomys/auto-consensus';

const MAX_RETRIES = 3;
const TIMEOUT = 30000; // 30 seconds

async function runWithRetry(fn, retries = MAX_RETRIES) {
  for (let i = 0; i < retries; i++) {
    try {
      return await fn();
    } catch (error) {
      if (i === retries - 1) throw error;
    }
  }
}

async function scrapeNetwork(page, url, networkId) {
  await page.goto(url, {
    waitUntil: 'networkidle0',
    timeout: TIMEOUT
  });

  await page.click('.Chain-Tab[title="Stats"]');
  await page.waitForSelector('.Chain-content table', { timeout: TIMEOUT });
  await new Promise(resolve => setTimeout(resolve, 500));

  const stats = await page.evaluate(() => {
    const getTextByMultipleSelectors = (selectors) => {
      for (const selector of selectors) {
        let element;
        try {
          if (selector.startsWith('/')) {
            element = document.evaluate(selector, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null).singleNodeValue;
          } else {
            element = document.querySelector(selector);
          }
          if (element) return element.textContent.trim();
        } catch (error) {}
      }
      return null;
    };

    return {
      nodeCount: getTextByMultipleSelectors(['.Chains-chain-selected .Chains-node-count']),
      subspaceNodeCount: getTextByMultipleSelectors([
        "#root > div > div.Chain > div.Chain-content-container > div > div > div:nth-child(2) > table > tbody > tr:nth-child(1) > td.Stats-count",
        "//*[@id='root']/div/div[2]/div[2]/div/div/div[2]/table/tbody/tr[1]/td[2]",
        "/html/body/div/div/div[2]/div[2]/div/div/div[2]/table/tbody/tr[1]/td[2]"
      ]),
      spaceAcresNodeCount: getTextByMultipleSelectors([
        "#root > div > div.Chain > div.Chain-content-container > div > div > div:nth-child(2) > table > tbody > tr:nth-child(2) > td.Stats-count",
        "//*[@id='root']/div/div[2]/div[2]/div/div/div[2]/table/tbody/tr[2]/td[2]",
        "/html/body/div/div/div[2]/div[2]/div/div/div[2]/table/tbody/tr[2]/td[2]"
      ]),
      linuxNodeCount: getTextByMultipleSelectors([
        "#root > div > div.Chain > div.Chain-content-container > div > div > div:nth-child(3) > table > tbody > tr:nth-child(1) > td.Stats-count",
        "//*[@id='root']/div/div[2]/div[2]/div/div/div[3]/table/tbody/tr[1]/td[2]",
        "/html/body/div/div/div[2]/div[2]/div/div/div[3]/table/tbody/tr[1]/td[2]"
      ]),
      windowsNodeCount: getTextByMultipleSelectors([
        "#root > div > div.Chain > div.Chain-content-container > div > div > div:nth-child(3) > table > tbody > tr:nth-child(2) > td.Stats-count",
        "//*[@id='root']/div/div[2]/div[2]/div/div/div[3]/table/tbody/tr[2]/td[2]",
        "/html/body/div/div/div[2]/div[2]/div/div/div[3]/table/tbody/tr[2]/td[2]"
      ]),
      macosNodeCount: getTextByMultipleSelectors([
        "#root > div > div.Chain > div.Chain-content-container > div > div > div:nth-child(3) > table > tbody > tr:nth-child(3) > td.Stats-count",
        "//*[@id='root']/div/div[2]/div[2]/div/div/div[3]/table/tbody/tr[3]/td[2]",
        "/html/body/div/div/div[2]/div[2]/div/div/div[3]/table/tbody/tr[3]/td[2]"
      ])
    };
  });

  console.log(`Fetching spacePledged for ${networkId}...`);
  const api = await activate({ networkId });
  const spacePledgedData = await spacePledged(api);

  return { stats, spacePledgedData };
}

export default async (req, context) => {
  return await runWithRetry(async () => {
    let browser;
    try {
      const { next_run } = req.body;
      console.log("Function invoked. Next run:", next_run);

      const auth = new google.auth.JWT({
        email: process.env.GOOGLE_CLOUD_CLIENT_EMAIL,
        key: process.env.GOOGLE_CLOUD_PRIVATE_KEY.replace(/\\n/g, '\n'),
        scopes: ['https://www.googleapis.com/auth/spreadsheets'],
      });

      const sheets = google.sheets({ version: 'v4', auth });
      const spreadsheetId = process.env.GOOGLE_SHEET_ID;

      // Function to get the timestamp of the last entry in a sheet
      const getLastEntryTimestamp = async (sheetName) => {
        const response = await sheets.spreadsheets.values.get({
          spreadsheetId,
          range: `${sheetName}!A:A`, // Assuming timestamps are in column A
        });
        const rows = response.data.values;
        if (rows && rows.length > 1) { // Skip header row
          const lastRow = rows[rows.length - 1];
          return new Date(lastRow[0]);
        }
        return null;
      };

      // Get current timestamp
      const currentTimestamp = new Date();

      // Check if data was updated less than 10 minutes ago
      const [chronosLastTimestamp, mainnetLastTimestamp] = await Promise.all([
        getLastEntryTimestamp('Chronos'),
        getLastEntryTimestamp('mainnet'),
      ]);

      const tenMinutes = 10 * 60 * 1000; // 10 minutes in milliseconds

      const shouldUpdateChronos = !chronosLastTimestamp || (currentTimestamp - chronosLastTimestamp) >= tenMinutes;
      const shouldUpdateMainnet = !mainnetLastTimestamp || (currentTimestamp - mainnetLastTimestamp) >= tenMinutes;

      // If neither needs updating, exit early
      if (!shouldUpdateChronos && !shouldUpdateMainnet) {
        console.log('Data was recently updated. Skipping this run.');
        return new Response(JSON.stringify({ message: "Data was recently updated. Skipping this run.", nextRun: next_run }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' }
        });
      }

      browser = await puppeteer.launch({
        args: [...chromium.args, '--no-sandbox'],
        defaultViewport: chromium.defaultViewport,
        executablePath: await chromium.executablePath(),
        headless: chromium.headless,
      });

      const results = [];
      const timestamp = currentTimestamp.toISOString();

      if (shouldUpdateChronos) {
        const chronosPage = await browser.newPage();
        const chronosData = await scrapeNetwork(
          chronosPage,
          'https://telemetry.subspace.network/#list/0x91912b429ce7bf2975440a0920b46a892fddeeaed6ccc11c93f2d57ad1bd69ab',
          'chronos'
        );
        console.log('Chronos data extracted:', { ...chronosData.stats, spacePledged: chronosData.spacePledgedData.toString() });
        results.push(
          sheets.spreadsheets.values.append({
            spreadsheetId,
            range: 'Chronos',
            valueInputOption: 'USER_ENTERED',
            resource: {
              values: [[
                timestamp,
                chronosData.stats.nodeCount || '',
                chronosData.spacePledgedData.toString(),
                chronosData.stats.subspaceNodeCount || '',
                chronosData.stats.spaceAcresNodeCount || '',
                chronosData.stats.linuxNodeCount || '',
                chronosData.stats.windowsNodeCount || '',
                chronosData.stats.macosNodeCount || ''
              ]]
            },
          })
        );
      } else {
        console.log('Chronos data was recently updated. Skipping.');
      }

      if (shouldUpdateMainnet) {
        const mainnetPage = await browser.newPage();
        const mainnetData = await scrapeNetwork(
          mainnetPage,
          'https://telemetry.subspace.network/#list/0x66455a580aabff303720aa83adbe6c44502922251c03ba73686d5245da9e21bd',
          'mainnet'
        );
        console.log('Mainnet data extracted:', { ...mainnetData.stats, spacePledged: mainnetData.spacePledgedData.toString() });
        results.push(
          sheets.spreadsheets.values.append({
            spreadsheetId,
            range: 'mainnet',
            valueInputOption: 'USER_ENTERED',
            resource: {
              values: [[
                timestamp,
                mainnetData.stats.nodeCount || '',
                mainnetData.spacePledgedData.toString(),
                mainnetData.stats.subspaceNodeCount || '',
                mainnetData.stats.spaceAcresNodeCount || '',
                mainnetData.stats.linuxNodeCount || '',
                mainnetData.stats.windowsNodeCount || '',
                mainnetData.stats.macosNodeCount || ''
              ]]
            },
          })
        );
      } else {
        console.log('Mainnet data was recently updated. Skipping.');
      }

      // Save data to Google Sheets if there are updates
      if (results.length > 0) {
        await Promise.all(results);
        console.log('Data appended to Google Sheets');
        return new Response(JSON.stringify({ message: "Data updated successfully", nextRun: next_run }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' }
        });
      } else {
        console.log('No data was appended to Google Sheets.');
        return new Response(JSON.stringify({ message: "No data needed updating.", nextRun: next_run }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' }
        });
      }
    } catch (error) {
      console.error('Error:', error.message);
      throw error;
    } finally {
      if (browser) await browser.close();
    }
  });
}

export const config = {
  schedule: "@daily"
};
