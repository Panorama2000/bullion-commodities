// xag-amm-oracle-bot-premium.js
// Pegs XAG/XRP AMM pool to real physical silver price using DIA on-ledger oracle
// TEMPORARY 8% premium added to target price to help bootstrap
// Runs every 2 minutes - fully automatic

const xrpl = require('xrpl');
const cron = require('node-cron');
require('dotenv').config();

const wallet = xrpl.Wallet.fromSeed(process.env.SEED);
const client = new xrpl.Client('wss://xrplcluster.com'); // Mainnet - change to Testnet URL for testing

const CURRENCY = 'XAG';
const ISSUER_ADDRESS = wallet.address;

// TEMPORARY PREMIUM - set to 1.0 when bootstrap is complete
const PREMIUM = 1.08;               // 8% above oracle price

// Adjustment settings
const ADJUST_THRESHOLD = 0.01;      // Trigger if deviation > 1%
const MAX_ADJUST_XRP = '1000';      // Max XRP adjustment per cycle (string)

// DIA oracle details (verify latest from xrpl.org or DIA)
const ORACLE_PROVIDER = 'rP24Lp7bcUHvEW7T7c8xkxtQKKd9fZyra7';
const ORACLE_DOC_ID = 42;           // Update if DIA changes document ID for silver

// ---------------------------------------------------------------
// Fetch silver price per oz in XRP using on-ledger oracle
// ---------------------------------------------------------------
async function fetchSilverXRPFromOracle() {
  const oracleRes = await client.request({
    command: 'ledger_entry',
    oracle: {
      account: ORACLE_PROVIDER,
      oracle_document_id: ORACLE_DOC_ID
    },
    ledger_index: 'validated'
  });

  const series = oracleRes.result.node.PriceDataSeries;

  const silverData = series.find(p => p.BaseAsset === 'XAG' && p.QuoteAsset === 'USD');
  const xrpData   = series.find(p => p.BaseAsset === 'XRP' && p.QuoteAsset === 'USD');

  if (!silverData || !xrpData) {
    throw new Error('Silver or XRP pair not found in oracle');
  }

  const silverUSD = parseInt(silverData.AssetPrice, 16) / Math.pow(10, silverData.Scale || 8);
  const xrpUSD   = parseInt(xrpData.AssetPrice, 16) / Math.pow(10, xrpData.Scale || 8);

  return (silverUSD / xrpUSD) * PREMIUM;  // Apply temporary 8% premium
}

// ---------------------------------------------------------------
// Get or create AMM pool
// ---------------------------------------------------------------
async function getOrCreateAMM() {
  try {
    const ammRes = await client.request({
      command: 'amm_info',
      asset: 'XRP',
      asset2: { currency: CURRENCY, issuer: ISSUER_ADDRESS }
    });
    return ammRes.result.amm.ammID;
  } catch (e) {
    console.log('Creating AMM pool (initial run)');
    const createTx = {
      TransactionType: 'AMMCreate',
      Account: wallet.address,
      Amount: xrpl.xrpToDrops('20000'), // Initial XRP liquidity - CHANGE THIS TO YOUR AMOUNT
      Amount2: { currency: CURRENCY, issuer: ISSUER_ADDRESS, value: '0' },
      TradingFee: 75  // 0.75% pool fee
    };
    const prepared = await client.autofill(createTx);
    const signed = wallet.sign(prepared);
    const resp = await client.submitAndWait(signed.tx_blob);
    console.log('AMM pool created');
    return resp.result.ammID;
  }
}

// ---------------------------------------------------------------
// Adjust AMM liquidity to maintain peg
// ---------------------------------------------------------------
async function updatePeg() {
  try {
    await client.connect();

    const targetPrice = await fetchSilverXRPFromOracle(); // per oz with premium

    const ammID = await getOrCreateAMM();
    const ammInfo = await client.request({
      command: 'amm_info',
      amm_id: ammID
    });

    const poolXRP = parseFloat(ammInfo.result.amm.amount);
    const poolXAG = parseFloat(ammInfo.result.amm.amount2.value);

    const currentPrice = poolXRP / (poolXAG / 1000); // per oz

    const deviation = (currentPrice - targetPrice) / targetPrice;

    console.log(`Current: ${currentPrice.toFixed(4)} XRP/oz | Target (with 8% premium): ${targetPrice.toFixed(4)} | Deviation: ${(deviation * 100).toFixed(2)}%`);

    if (Math.abs(deviation) < ADJUST_THRESHOLD) {
      console.log('Within threshold - no adjustment');
      return;
    }

    const adjustDirection = deviation > 0 ? -1 : 1; // + = too high, need to lower; - = too low, need to raise
    const adjustXrp = Math.min(Math.abs(deviation) * 20000, parseFloat(MAX_ADJUST_XRP));

    if (adjustDirection > 0) {
      // Add XRP to raise XAG price
      const depositTx = {
        TransactionType: 'AMMDeposit',
        Account: wallet.address,
        Amount: xrpl.xrpToDrops(adjustXrp.toString()),
        Amount2: { currency: CURRENCY, issuer: ISSUER_ADDRESS, value: '0' },
        AMMID: ammID
      };
      const prepared = await client.autofill(depositTx);
      const signed = wallet.sign(prepared);
      await client.submitAndWait(signed.tx_blob);
      console.log(`Deposited ${adjustXrp} XRP to raise price`);
    } else {
      // Withdraw XRP to lower XAG price
      const withdrawTx = {
        TransactionType: 'AMMWithdraw',
        Account: wallet.address,
        Amount: xrpl.xrpToDrops(adjustXrp.toString()),
        Amount2: { currency: CURRENCY, issuer: ISSUER_ADDRESS, value: '0' },
        AMMID: ammID
      };
      const prepared = await client.autofill(withdrawTx);
      const signed = wallet.sign(prepared);
      await client.submitAndWait(signed.tx_blob);
      console.log(`Withdrew ${adjustXrp} XRP to lower price`);
    }

  } catch (error) {
    console.error('Error:', error.message || error);
  } finally {
    await client.disconnect();
  }
}

// Run every 2 minutes
cron.schedule('*/2 * * * *', updatePeg);

// Run once immediately on start
updatePeg();

console.log('XAG AMM peg bot started with temporary 8% premium');
