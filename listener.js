// listener.js

const TronWeb = require('tronweb');
const { ethers } = require('ethers');
const { createClient } = require('@supabase/supabase-js');
require('dotenv').config();

// Inicialización de Supabase
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_KEY;
const supabase = createClient(supabaseUrl, supabaseKey);

// --- CONFIGURACIÓN ---
const TRON_TREASURY_ADDRESS = 'TB3idCQ8aojaeMx9kdudp6vgN3TWJFdrTW';
const BSC_TREASURY_ADDRESS = '0xa92dD1DdE84Ec6Ea88733dd290F40186bbb1dD74';
const ETHERSCAN_API_KEY = process.env.ETHERSCAN_API_KEY;
const TRONGRID_API_KEY = process.env.TRONGRID_API_KEY;

console.log('Listener de pagos multi-cadena configurado.');

/**
 * Busca y procesa pagos pendientes en la red de TRON.
 */
async function checkTronPayments() {
    console.log('[TRON] Iniciando ciclo de chequeo...');
    try {
        const { data: pendingOrders, error } = await supabase.from('payment_orders').select('user_id, amount').eq('status', 'pending');
        if (error) throw error;
        if (!pendingOrders || pendingOrders.length === 0) {
            console.log('[TRON] No se encontraron órdenes pendientes.');
            return;
        }

        const apiUrl = `https://api.nile.trongrid.io/v1/accounts/${TRON_TREASURY_ADDRESS}/transactions?limit=50&only_to=true`;
        
        const response = await fetch(apiUrl, {
            method: 'GET',
            headers: {
                'Content-Type': 'application/json',
                'TRON-PRO-API-KEY': TRONGRID_API_KEY
            }
        });

        if (!response.ok) throw new Error(`Error de API TronGrid: ${response.statusText}`);
        const data = await response.json();

        if (data.success && data.data.length > 0) {
            for (const tx of data.data) {
                if (tx.raw_data.contract[0].type === 'TriggerSmartContract') {
                    const contractData = tx.raw_data.contract[0].parameter.value;
                    if (contractData.data && contractData.data.startsWith('a9059cbb')) {
                        const amount_paid = parseInt(contractData.data.substring(72), 16) / 1_000_000;
                        const matchingOrder = pendingOrders.find(order => Math.abs(order.amount - amount_paid) < 0.00001);

                        if (matchingOrder) {
                            console.log(`[TRON] Coincidencia encontrada! Monto: ${amount_paid}, Usuario ID: ${matchingOrder.user_id}`);
                            await activateUser(matchingOrder.user_id, tx.txID);
                        }
                    }
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
    console.log('[BSC] Iniciando ciclo de chequeo...');
    try {
        const { data: pendingOrders, error } = await supabase.from('payment_orders').select('user_id, amount').eq('status', 'pending');
        if (error) throw error;
        if (!pendingOrders || pendingOrders.length === 0) {
            console.log('[BSC] No se encontraron órdenes pendientes.');
            return;
        }
        
        const apiUrl = `https://api-testnet.bscscan.com/api?module=account&action=tokentx&address=${BSC_TREASURY_ADDRESS}&startblock=0&endblock=99999999&sort=desc&apikey=${ETHERSCAN_API_KEY}`;
        const response = await fetch(apiUrl);
        if (!response.ok) throw new Error(`Error de API BscScan: ${response.statusText}`);
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
    console.log(`Intentando activar usuario ${userId}...`);
    const { error: updateUserError } = await supabase.from('users').update({ status: 'activo' }).eq('id', userId);
    if (updateUserError) {
        console.error(`Error al activar usuario ${userId}:`, updateUserError);
        throw updateUserError;
    }

    const { error: updateOrderError } = await supabase.from('payment_orders').update({ status: 'completed', transaction_hash: transactionHash }).eq('user_id', userId);
    if (updateOrderError) {
        console.error(`Error al actualizar orden para usuario ${userId}:`, updateOrderError);
        throw updateOrderError;
    }

    console.log(`Usuario con ID ${userId} ha sido activado. Hash: ${transactionHash}`);
}

/**
 * Función para iniciar el listener y hacer que se ejecute periódicamente.
 */
function startListener() {
    const checkInterval = 15000; // 15 segundos
    console.log(`Iniciando listeners. Se ejecutarán cada ${checkInterval / 1000} segundos.`);
    
    const runChecks = async () => {
        console.log("--- Nuevo ciclo de búsqueda de pagos ---");
        await Promise.all([ checkTronPayments(), checkBscPayments() ]).catch(err => {
            console.error("Error crítico durante la ejecución paralela de los listeners:", err);
        });
    };

    try {
        setTimeout(runChecks, 3000); // Un pequeño delay inicial para que el servidor se estabilice
        setInterval(runChecks, checkInterval);
        console.log(`Listeners configurados para ejecutarse cada ${checkInterval / 1000} segundos.`);
    } catch (initialRunError) {
        console.error("Error fatal durante el arranque del listener:", initialRunError);
    }
}

module.exports = { startListener };
