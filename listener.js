const { ethers } = require('ethers');
const { createClient } = require('@supabase/supabase-js');
require('dotenv').config();
const logger = require('./logger');

// Inicialización de Supabase
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_KEY;
const supabase = createClient(supabaseUrl, supabaseKey);

// Configuración producción
const TRON_TREASURY_ADDRESS = process.env.TRON_TREASURY_ADDRESS;
const BSC_TREASURY_ADDRESS = process.env.BSC_TREASURY_ADDRESS;
const ETHERSCAN_API_KEY = process.env.ETHERSCAN_API_KEY;
const TRONGRID_API_KEY = process.env.TRONGRID_API_KEY;

// Contratos mainnet
const TRON_USDT_CONTRACT = 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t'; // USDT Mainnet
const BSC_USDT_CONTRACT = '0x55d398326f99059ff775485246999027b3197955'; // USDT BSC Mainnet

// Validadores
const isValidTronAddress = (address) => /^T[1-9A-HJ-NP-Za-km-z]{33}$/.test(address);
const isValidBscAddress = (address) => /^0x[a-fA-F0-9]{40}$/.test(address);

if (!isValidTronAddress(TRON_TREASURY_ADDRESS)) throw new Error('Dirección TRON inválida en .env');
if (!isValidBscAddress(BSC_TREASURY_ADDRESS)) throw new Error('Dirección BSC inválida en .env');

logger.info('Listener producción - Mainnet iniciado', {
    tron_address: TRON_TREASURY_ADDRESS,
    bsc_address: BSC_TREASURY_ADDRESS
});

// Configuración flexible para testing
const CONFIG = {
    TESTING_MODE: process.env.TESTING_MODE === "true",
    BASE_AMOUNT: process.env.TESTING_MODE === "true" ? 1 : 15,
    TOLERANCE: 0.01,
    POLL_INTERVAL: process.env.TESTING_MODE === "true" ? 5000 : 10000,
    API_TIMEOUT: 15000,
    MAX_API_RETRIES: 3,
    DEFAULT_EXPIRATION_MINUTES: 15
};

logger.info(`Configuración del listener`, {
    mode: CONFIG.TESTING_MODE ? 'TESTING' : 'PRODUCCIÓN',
    base_amount: `${CONFIG.BASE_AMOUNT} USDT (con ajuste aleatorio)`,
    tolerance: `${CONFIG.TOLERANCE} USDT`,
    poll_interval: `${CONFIG.POLL_INTERVAL/1000}s`
});

/**
 * TRON MAINNET
 */
async function checkTronPayments() {
    logger.info(`[TRON] Verificando pagos ${CONFIG.TESTING_MODE ? `(Testing: ~${CONFIG.BASE_AMOUNT}.00xxx USDT)` : '(Producción)'}`);
    
    try {
        const { data: pendingOrders, error } = await supabase
            .from('payment_orders')
            .select('user_id, amount, created_at, id')
            .eq('status', 'pending');

        if (error) throw error;
        if (!pendingOrders?.length) {
            logger.info('[TRON] Sin órdenes pendientes');
            return;
        }

        const validOrders = pendingOrders;
        if (validOrders.length === 0) {
            logger.warn('[TRON] No hay órdenes pendientes válidas');
            return;
        }

        const apis = [
            {
                name: 'TronScan Mainnet',
                url: `https://apilist.tronscan.org/api/token_trc20/transfers?limit=50&start=0&sort=-timestamp&toAddress=${TRON_TREASURY_ADDRESS}&filterTokenValue=0`,
                parser: parseTronScanResponse
            },
            {
                name: 'TronScan Alt',
                url: `https://api.tronscan.org/api/token_trc20/transfers?limit=50&relatedAddress=${TRON_TREASURY_ADDRESS}&filterTokenValue=0`,
                parser: parseTronScanResponse
            },
            {
                name: 'TronGrid Mainnet',
                url: `https://api.trongrid.io/v1/accounts/${TRON_TREASURY_ADDRESS}/transactions/trc20?limit=50&only_to=true`,
                parser: parseTronGridResponse
            }
        ];

        for (const api of apis) {
            let retries = 0;
            while (retries < CONFIG.MAX_API_RETRIES) {
                try {
                    logger.info(`[TRON] Consultando ${api.name} (Intento ${retries + 1})`);
                    
                    const response = await fetch(api.url, {
                        headers: {
                            'Content-Type': 'application/json',
                            'Accept': 'application/json',
                            'User-Agent': 'PaymentListener/1.0',
                            ...(TRONGRID_API_KEY && { 'TRON-PRO-API-KEY': TRONGRID_API_KEY })
                        },
                        timeout: CONFIG.API_TIMEOUT
                    });

                    if (!response.ok) {
                        logger.warn(`[TRON] Error en ${api.name}`, { status: response.status });
                        retries++;
                        continue;
                    }

                    const data = await response.json();
                    const transactions = api.parser(data);
                    
                    if (transactions.length > 0) {
                        logger.info(`[TRON] ${api.name}: ${transactions.length} transacciones encontradas`);
                        
                        for (const tx of transactions) {
                            const { data: existingTx, error: txError } = await supabase
                                .from('payment_orders')
                                .select('id')
                                .eq('transaction_hash', tx.hash)
                                .single();

                            if (txError && txError.code !== 'PGRST116') {
                                logger.error('[TRON] Error verificando hash existente', { hash: tx.hash, error: txError.message });
                                continue;
                            }

                            if (existingTx) {
                                logger.warn('[TRON] Hash ya procesado, omitiendo', { hash: tx.hash });
                                continue;
                            }
                            
                            logger.info(`[TRON] Verificando transacción: ${tx.amount} USDT`, { hash: tx.hash });
                            
                            const matchingOrder = validOrders.find(order => 
                                Math.abs(order.amount - tx.amount) < CONFIG.TOLERANCE
                            );

                            if (matchingOrder) {
                                logger.info(`[TRON] Pago detectado para orden ${matchingOrder.id}`, {
                                    amount: tx.amount,
                                    user_id: matchingOrder.user_id,
                                    hash: tx.hash
                                });
                                
                                await activateUser(matchingOrder.user_id, tx.hash, 'TRON', tx.amount);
                                await sendPaymentNotification(matchingOrder, tx, 'TRON');
                            } else {
                                logger.warn(`[TRON] Sin coincidencia para ${tx.amount} USDT`, { hash: tx.hash });
                            }
                        }
                        
                        return;
                    }
                    break;
                } catch (apiError) {
                    logger.warn(`[TRON] Error en ${api.name} (Intento ${retries + 1})`, { error: apiError.message });
                    retries++;
                    if (retries >= CONFIG.MAX_API_RETRIES) break;
                }
            }
        }

        logger.info('[TRON] No se encontraron transacciones en ninguna API');

    } catch (error) {
        logger.error('[TRON] Error general en verificación de pagos', { error: error.message });
    }
}

/**
 * BSC MAINNET
 */
async function checkBscPayments() {
    logger.info(`[BSC] Verificando pagos ${CONFIG.TESTING_MODE ? `(Testing: ~${CONFIG.BASE_AMOUNT}.00xxx USDT)` : '(Producción)'}`);

    if (!ETHERSCAN_API_KEY) {
        logger.error('[BSC] ETHERSCAN_API_KEY requerida');
        return;
    }

    try {
        const { data: pendingOrders, error } = await supabase
            .from('payment_orders')
            .select('user_id, amount, created_at, id')
            .eq('status', 'pending');
            
        if (error) throw error;
        if (!pendingOrders?.length) {
            logger.info('[BSC] Sin órdenes pendientes');
            return;
        }

        const validOrders = pendingOrders;
        if (validOrders.length === 0) {
            logger.warn('[BSC] No hay órdenes pendientes válidas');
            return;
        }

        const apiUrl = `https://api.bscscan.com/api?module=account&action=tokentx&contractaddress=${BSC_USDT_CONTRACT}&address=${BSC_TREASURY_ADDRESS}&page=1&offset=50&sort=desc&apikey=${ETHERSCAN_API_KEY}`;
        
        const response = await fetch(apiUrl, { timeout: CONFIG.API_TIMEOUT });
        if (!response.ok) throw new Error(`BscScan error: ${response.statusText}`);
        
        const data = await response.json();
        if (data.status === "1" && data.result?.length > 0) {
            logger.info(`[BSC] ${data.result.length} transacciones encontradas`);
            
            for (const tx of data.result) {
                const { data: existingTx, error: txError } = await supabase
                    .from('payment_orders')
                    .select('id')
                    .eq('transaction_hash', tx.hash)
                    .single();

                if (txError && txError.code !== 'PGRST116') {
                    logger.error('[BSC] Error verificando hash existente', { hash: tx.hash, error: txError.message });
                    continue;
                }

                if (existingTx) {
                    logger.warn('[BSC] Hash ya procesado, omitiendo', { hash: tx.hash });
                    continue;
                }
                
                const amount = parseFloat(ethers.formatUnits(tx.value, parseInt(tx.tokenDecimal || 18)));
                
                logger.info(`[BSC] Verificando transacción: ${amount} ${tx.tokenSymbol}`, { hash: tx.hash });
                
                const matchingOrder = validOrders.find(order => 
                    Math.abs(order.amount - amount) < CONFIG.TOLERANCE
                );
                
                if (matchingOrder) {
                    logger.info(`[BSC] Pago detectado para orden ${matchingOrder.id}`, {
                        amount: amount,
                        user_id: matchingOrder.user_id,
                        hash: tx.hash
                    });
                    
                    await activateUser(matchingOrder.user_id, tx.hash, 'BSC', amount);
                    await sendPaymentNotification(matchingOrder, { hash: tx.hash, amount }, 'BSC');
                }
            }
        } else {
            logger.info('[BSC] No hay transacciones recientes');
        }
    } catch (error) {
        logger.error('[BSC] Error en verificación de pagos', { error: error.message });
    }
}

/**
 * Parsers para diferentes APIs
 */
function parseTronScanResponse(data) {
    if (!data.token_transfers) return [];
    
    return data.token_transfers
        .filter(tx => 
            tx.contractAddress === TRON_USDT_CONTRACT && 
            tx.to_address === TRON_TREASURY_ADDRESS &&
            tx.tokenInfo?.tokenSymbol === 'USDT'
        )
        .map(tx => ({
            amount: parseFloat(tx.quant) / Math.pow(10, tx.tokenInfo.tokenDecimal || 6),
            hash: tx.transaction_id,
            timestamp: tx.block_timestamp,
            from: tx.from_address
        }));
}

function parseTronGridResponse(data) {
    if (!data.data) return [];
    
    return data.data
        .filter(tx => 
            tx.token_info?.address === TRON_USDT_CONTRACT &&
            tx.to === TRON_TREASURY_ADDRESS
        )
        .map(tx => ({
            amount: parseInt(tx.value) / Math.pow(10, tx.token_info.decimals || 6),
            hash: tx.transaction_id,
            timestamp: tx.block_timestamp,
            from: tx.from
        }));
}

/**
 * Activación de usuario
 */
async function activateUser(userId, transactionHash, network, amount) {
    const startTime = Date.now();
    logger.info(`Activando usuario ${userId} en ${network}`);
    
    try {
        const { data: currentUser, error: fetchError } = await supabase
            .from('users')
            .select('id, status, username')
            .eq('id', userId)
            .single();

        if (fetchError) throw fetchError;

        if (currentUser?.status === 'activo') {
            logger.warn(`Usuario ${userId} ya está activo`, { username: currentUser.username });
            return;
        }

        const { error: userError } = await supabase
            .from('users')
            .update({ status: 'activo' })
            .eq('id', userId);
            
        if (userError) throw userError;

        const { error: orderError } = await supabase
            .from('payment_orders')
            .update({ 
                status: 'completed', 
                transaction_hash: transactionHash,
                network: network,
                completed_at: new Date().toISOString()
            })
            .eq('user_id', userId)
            .eq('status', 'pending');
            
        if (orderError) throw orderError;

        const duration = Date.now() - startTime;
        logger.info(`Activación exitosa para usuario ${userId}`, {
            username: currentUser.username,
            amount: amount,
            network: network,
            hash: transactionHash,
            duration_ms: duration
        });

    } catch (error) {
        logger.error(`Error activando usuario ${userId}`, { error: error.message });
    }
}

/**
 * Notificaciones
 */
async function sendPaymentNotification(order, transaction, network) {
    try {
        logger.info(`Notificación: Pago recibido para usuario ${order.user_id}`, {
            amount: transaction.amount,
            network: network,
            hash: transaction.hash
        });
    } catch (error) {
        logger.error('Error enviando notificación', { error: error.message });
    }
}

/**
 * Marcar órdenes expiradas
 */
async function markExpiredOrders() {
    try {
        const fifteenMinutesAgo = new Date(Date.now() - CONFIG.DEFAULT_EXPIRATION_MINUTES * 60 * 1000);
        
        const { data, error } = await supabase
            .from('payment_orders')
            .update({ status: 'expired' })
            .eq('status', 'pending')
            .lt('created_at', fifteenMinutesAgo.toISOString());
        
        if (error) throw error;

        if (data && data.length > 0) {
            logger.info(`${data.length} órdenes marcadas como expiradas`);
        }
    } catch (error) {
        logger.error('Error marcando órdenes expiradas', { error: error.message });
    }
}

/**
 * Función principal del listener
 */
function startListener() {
    logger.info(`Iniciando Listener en modo ${CONFIG.TESTING_MODE ? 'TESTING' : 'PRODUCCIÓN'}`, {
        interval: `${CONFIG.POLL_INTERVAL/1000}s`,
        base_amount: `${CONFIG.BASE_AMOUNT} USDT`,
        tolerance: `${CONFIG.TOLERANCE} USDT`
    });
    
    const runChecks = async () => {
        const cycleStart = Date.now();
        logger.info(`Iniciando nuevo ciclo de verificación`);
        
        await Promise.allSettled([
            markExpiredOrders(),
            checkTronPayments(),
            checkBscPayments()
        ]);
        
        const cycleDuration = Date.now() - cycleStart;
        logger.info(`Ciclo completado`, { duration_ms: cycleDuration });
    };

    setTimeout(runChecks, 5000);
    setInterval(runChecks, CONFIG.POLL_INTERVAL);
    
    logger.info(`Listener iniciado correctamente`);
}

process.on('unhandledRejection', (reason, promise) => {
    logger.error('Unhandled Rejection', { reason: reason.message || reason });
});

process.on('uncaughtException', (error) => {
    logger.error('Uncaught Exception', { error: error.message });
});

module.exports = { startListener };