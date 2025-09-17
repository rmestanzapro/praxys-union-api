// listener.js

const TronWeb = require('tronweb');
const { ethers } = require('ethers');
const { createClient } = require('@supabase/supabase-js');
require('dotenv').config();

// Inicialización de Supabase
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_KEY;
const supabase = createClient(supabaseUrl, supabaseKey);

// --- CONFIGURACIÓN DE BILLETERAS Y REDES ---
const TRON_TREASURY_ADDRESS = 'TB3idCQ8aojaeMx9kdudp6vgN3TWJFdrTW';
const BSC_TREASURY_ADDRESS = '0xa92dD1DdE84Ec6Ea88733dd290F40186bbb1dD74'; // Asegúrate que esta sea tu dirección de prueba de BSC
const ETHERSCAN_API_KEY = process.env.ETHERSCAN_API_KEY; 

// Configuración para TRON (Nile Testnet)
const tronWeb = new TronWeb({ fullHost: 'https://api.nile.trongrid.io' });

// Configuración para BSC (Testnet)
const bscProvider = new ethers.JsonRpcProvider('https://data-seed-prebsc-1-s1.binance.org:8545/');

console.log('Listener de pagos multi-cadena configurado.');

/**
 * Busca y procesa pagos pendientes en la red de TRON.
 */
async function checkTronPayments() {
    try {
        const { data: pendingOrders, error } = await supabase
            .from('payment_orders')
            .select('user_id, amount')
            .eq('status', 'pending');

        if (error) throw error;
        if (!pendingOrders || pendingOrders.length === 0) return;

        const transactions = await tronWeb.getTransactionsToAddress(TRON_TREASURY_ADDRESS, 30, 0);

        for (const tx of transactions) {
            if (tx.raw_data.contract[0].type === 'TriggerSmartContract') {
                const contractData = tx.raw_data.contract[0].parameter.value;
                const amount_paid = parseInt(contractData.data.substring(72), 16) / 1_000_000;

                const matchingOrder = pendingOrders.find(order => Math.abs(order.amount - amount_paid) < 0.00001);

                if (matchingOrder) {
                    console.log(`[TRON] Coincidencia encontrada! Monto: ${amount_paid}, Usuario ID: ${matchingOrder.user_id}`);
                    await activateUser(matchingOrder.user_id, tx.txID);
                }
            }
        }
    } catch (error) {
        console.error('Error en el listener de TRON:', error.message);
    }
}

/**
 * Busca y procesa pagos pendientes en la red de BSC.
 */
async function checkBscPayments() {
    try {
        const { data: pendingOrders, error } = await supabase
            .from('payment_orders')
            .select('user_id, amount')
            .eq('status', 'pending');

        if (error) throw error;
        if (!pendingOrders || pendingOrders.length === 0) return;

        const apiUrl = `https://api-testnet.bscscan.com/api?module=account&action=tokentx&address=${BSC_TREASURY_ADDRESS}&startblock=0&endblock=99999999&sort=desc&apikey=${ETHERSCAN_API_KEY}`;
        const response = await fetch(apiUrl);
        const data = await response.json();

        if (data.status === "1" && data.result.length > 0) {
            for (const tx of data.result) {
                const amount_paid = parseFloat(ethers.formatUnits(tx.value, 18));
                
                const matchingOrder = pendingOrders.find(order => Math.abs(order.amount - amount_paid) < 0.00001);

                if (matchingOrder) {
                    console.log(`[BSC] Coincidencia encontrada! Monto: ${amount_paid}, Usuario ID: ${matchingOrder.user_id}`);
                    await activateUser(matchingOrder.user_id, tx.hash);
                }
            }
        }
    } catch (error) {
        console.error('Error en el listener de BSC:', error.message);
    }
}

/**
 * Función centralizada para activar un usuario y actualizar su orden.
 */
async function activateUser(userId, transactionHash) {
    // Activamos al usuario
    const { error: updateUserError } = await supabase
        .from('users')
        .update({ status: 'activo' })
        .eq('id', userId);
    
    if (updateUserError) throw updateUserError;

    // Y actualizamos la orden a 'completed' y guardamos el hash de la transacción
    const { error: updateOrderError } = await supabase
        .from('payment_orders')
        .update({ status: 'completed', transaction_hash: transactionHash })
        .eq('user_id', userId);
    
    if (updateOrderError) throw updateOrderError;

    console.log(`Usuario con ID ${userId} ha sido activado. Hash: ${transactionHash}`);
}


/**
 * Función para iniciar el listener y hacer que se ejecute periódicamente.
 */
function startListener() {
    const checkInterval = 15000; // 15 segundos
    console.log(`Iniciando listeners. Se ejecutarán cada ${checkInterval / 1000} segundos.`);
    
    checkTronPayments();
    checkBscPayments();
    
    setInterval(checkTronPayments, checkInterval);
    setInterval(checkBscPayments, checkInterval);
}

module.exports = { startListener };