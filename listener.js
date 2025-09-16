// listener.js
const TronWeb = require('tronweb');
const { ethers } = require('ethers');
const { createClient } = require('@supabase/supabase-js');
require('dotenv').config();

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_KEY;
const supabase = createClient(supabaseUrl, supabaseKey);

const TRON_TREASURY_ADDRESS = 'TB3idCQ8aojaeMx9kdudp6vgN3TWJFdrTW';
const BSC_TREASURY_ADDRESS = 'TU_DIRECCIÓN_DE_BSC_TESTNET_AQUÍ'; 
const BSCSCAN_API_KEY = process.env.BSCSCAN_API_KEY;

const tronWeb = new TronWeb({ fullHost: 'https://api.nile.trongrid.io' });
const bscProvider = new ethers.JsonRpcProvider('https://data-seed-prebsc-1-s1.binance.org:8545/');

console.log('Listener de pagos multi-cadena configurado.');

async function checkTronPayments() { /* ... Lógica de Tron ... */ }
async function checkBscPayments() { /* ... Lógica de BSC ... */ }
async function activateUser(userId) { /* ... Lógica de activación ... */ }

function startListener() {
    const checkInterval = 15000;
    console.log(`Iniciando listeners. Se ejecutarán cada ${checkInterval / 1000} segundos.`);
    checkTronPayments();
    checkBscPayments();
    setInterval(checkTronPayments, checkInterval);
    setInterval(checkBscPayments, checkInterval);
}

module.exports = { startListener };
