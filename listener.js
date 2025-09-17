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
const TRON_TREASURY_ADDRESS = 'TEoscc63B9U96qN5cXWkaGqNBYJZhLQdJV';
const BSC_TREASURY_ADDRESS = '0xa92dD1DdE84Ec6Ea88733dd290F40186bbb1dD74';
const ETHERSCAN_API_KEY = process.env.ETHERSCAN_API_KEY;
const TRON_USDT_CONTRACT_ADDRESS = 'TXYZopYRdj2D9XRtbG411XZZ3kM5VkM3Uo';

console.log('Listener de pagos multi-cadena configurado.');

/**
 * Busca y procesa pagos pendientes en la red de TRON usando la API de TronScan con fallback a TronGrid.
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
        console.log(`[TRON] Encontradas ${pendingOrders.length} órdenes pendientes.`);

        // Usar TronScan API como alternativa más confiable
        const apiUrl = `https://nileapi.tronscan.org/api/token_trc20/transfers?limit=50&start=0&sort=-timestamp&count=true&filterTokenValue=0&relatedAddress=${TRON_TREASURY_ADDRESS}`;
        console.log(`[TRON] Consultando TronScan API: ${apiUrl}`);
        
        const response = await fetch(apiUrl);
        if (!response.ok) {
            throw new Error(`Error de API TronScan: ${response.status} - ${response.statusText}`);
        }
        
        const data = await response.json();

        if (data.token_transfers && data.token_transfers.length > 0) {
            for (const transfer of data.token_transfers) {
                // Verificar que sea USDT y que sea hacia nuestra dirección
                if (transfer.contractAddress === TRON_USDT_CONTRACT_ADDRESS && 
                    transfer.to_address === TRON_TREASURY_ADDRESS) {
                    
                    const amount_paid = parseFloat(transfer.quant) / Math.pow(10, transfer.tokenInfo.tokenDecimal);
                    
                    // Buscar orden coincidente
                    const matchingOrder = pendingOrders.find(order => Math.abs(order.amount - amount_paid) < 0.00001);

                    if (matchingOrder) {
                        console.log(`[TRON] Coincidencia encontrada! Monto: ${amount_paid}, Usuario ID: ${matchingOrder.user_id}`);
                        await activateUser(matchingOrder.user_id, transfer.transaction_id);
                    }
                }
            }
        } else {
            console.log('[TRON] No se encontraron transacciones TRC20 recientes.');
        }
    } catch (error) {
        console.error('Error en el listener de TRON:', error.message);
        
        // Si TronScan falla, intentar con TronGrid básico
        try {
            console.log('[TRON] Intentando con TronGrid básico...');
            const fallbackUrl = `https://nile.trongrid.io/v1/accounts/${TRON_TREASURY_ADDRESS}/transactions?limit=20`;
            const fallbackResponse = await fetch(fallbackUrl);
            
            if (fallbackResponse.ok) {
                const fallbackData = await fallbackResponse.json();
                console.log('[TRON] Conexión con TronGrid básico exitosa');
            }
        } catch (fallbackError) {
            console.error('[TRON] Error también en TronGrid básico:', fallbackError.message);
        }
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
        console.log(`[BSC] Encontradas ${pendingOrders.length} órdenes pendientes.`);
        
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
    if (updateUserError) throw updateUserError;

    const { error: updateOrderError } = await supabase.from('payment_orders').update({ status: 'completed', transaction_hash: transactionHash }).eq('user_id', userId);
    if (updateOrderError) throw updateOrderError;

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
        setTimeout(runChecks, 3000);
        setInterval(runChecks, checkInterval);
        console.log(`Listeners configurados para ejecutarse cada ${checkInterval / 1000} segundos.`);
    } catch (initialRunError) {
        console.error("Fatal error during listener startup:", initialRunError);
    }
}

module.exports = { startListener };
